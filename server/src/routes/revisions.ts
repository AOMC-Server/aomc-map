import type { Role } from "@aomc/shared";
import { and, desc, eq, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import {
	dimensions,
	jobs,
	revisions,
	uploadPatches,
	users,
} from "../db/schema";
import { doc } from "../openapi";
import { canDeleteUpload, canModerate, loadMap } from "../permissions";
import type { ProgressEvent } from "../progress";
import type { AppEnv } from "../types";
import { parseId } from "./util";

const revisionFields = {
	id: revisions.id,
	rev: revisions.rev,
	kind: revisions.kind,
	dimensionId: revisions.dimensionId,
	authorId: revisions.authorId,
	authorName: users.username,
	targetRevisionId: revisions.targetRevisionId,
	status: revisions.status,
	error: revisions.error,
	bboxMinX: revisions.bboxMinX,
	bboxMinZ: revisions.bboxMinZ,
	bboxMaxX: revisions.bboxMaxX,
	bboxMaxZ: revisions.bboxMaxZ,
	fileCount: revisions.fileCount,
	viaMod: revisions.viaMod,
	reverted: revisions.reverted,
	createdAt: revisions.createdAt,
	exportedAt: revisions.exportedAt,
	completedAt: revisions.completedAt,
};

type RevisionRow = NonNullable<ReturnType<typeof loadRevision>>;

type DeleteAccess = {
	actor: { id: string } | null;
	role: Role;
	windowMs: number;
	now: number;
};

function deleteAccess(c: Context<AppEnv>): DeleteAccess {
	return {
		actor: c.var.user,
		role: c.var.role,
		windowMs: c.var.env.SELF_DELETE_WINDOW_HOURS * 3_600_000,
		now: Date.now(),
	};
}

function serialize(r: RevisionRow, access: DeleteAccess) {
	const { bboxMinX, bboxMinZ, bboxMaxX, bboxMaxZ, ...rest } = r;
	const canDelete =
		r.kind === "upload" &&
		canDeleteUpload(access.actor, access.role, r, access.windowMs, access.now);
	const own = access.actor !== null && access.actor.id === r.authorId;
	const deletableUntil =
		canDelete && own && !canModerate(access.role)
			? r.createdAt + access.windowMs
			: null;
	const bbox =
		bboxMinX === null ||
		bboxMinZ === null ||
		bboxMaxX === null ||
		bboxMaxZ === null
			? null
			: { minX: bboxMinX, minZ: bboxMinZ, maxX: bboxMaxX, maxZ: bboxMaxZ };
	return { ...rest, bbox, canDelete, deletableUntil };
}

function loadRevision(db: Db, id: number) {
	return db
		.select(revisionFields)
		.from(revisions)
		.innerJoin(users, eq(users.id, revisions.authorId))
		.where(eq(revisions.id, id))
		.get();
}

export const revisionRoutes = new Hono<AppEnv>()
	/** Newest first, for the history panel. */
	.get(
		"/",
		doc({
			tag: "Revisions",
			summary: "List revisions, newest first",
			description:
				"`viaMod` is true for uploads sent by the in-game mod (recognised by its `User-Agent`, see `MOD_USER_AGENTS`). Page through older ones with `before`; `nextBefore` is the value for the next page, or null after the last one. `canDelete` says whether you may delete the upload, and `deletableUntil` when that ends for your own uploads (null = no limit or not yours).",
			query: {
				limit: "At most this many (1 to 1000, default 200)",
				before: "Only revisions with a smaller id (for paging)",
				dimension:
					"Only revisions in this dimension (slug); reverts and restores of its uploads are included",
				active:
					"Also include revisions with these ids (comma separated) whatever the other filters, e.g. ones still being processed",
			},
			fails: [404],
		}),
		async (c) => {
			const { db } = c.var;
			const limit = Math.min(
				Math.max(Number(c.req.query("limit")) || 200, 1),
				1000,
			);
			const filters: SQL[] = [];
			const before = Number(c.req.query("before"));
			if (c.req.query("before") && Number.isSafeInteger(before))
				filters.push(lt(revisions.id, before));
			const slug = c.req.query("dimension");
			if (slug) {
				const dim = await db
					.select({ id: dimensions.id })
					.from(dimensions)
					.where(eq(dimensions.slug, slug))
					.get();
				if (!dim) return c.json({ error: "not found" }, 404);
				filters.push(
					or(
						eq(revisions.dimensionId, dim.id),
						sql`${revisions.targetRevisionId} in (select ${revisions.id} from ${revisions} where ${revisions.dimensionId} = ${dim.id})`,
					) as SQL,
				);
			}
			const rows = await db
				.select(revisionFields)
				.from(revisions)
				.innerJoin(users, eq(users.id, revisions.authorId))
				.where(filters.length ? and(...filters) : undefined)
				.orderBy(desc(revisions.id))
				.limit(limit);
			const active = (c.req.query("active") ?? "")
				.split(",")
				.map(Number)
				.filter((id) => Number.isSafeInteger(id) && id > 0)
				.filter((id) => !rows.some((r) => r.id === id))
				.slice(0, 100);
			const extra = active.length
				? await db
						.select(revisionFields)
						.from(revisions)
						.innerJoin(users, eq(users.id, revisions.authorId))
						.where(inArray(revisions.id, active))
				: [];
			const access = deleteAccess(c);
			return c.json({
				revisions: [...rows, ...extra]
					.sort((a, b) => b.id - a.id)
					.map((r) => serialize(r, access)),
				nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
			});
		},
	)
	.get(
		"/:id",
		doc({
			tag: "Revisions",
			summary: "Get a revision",
			description:
				"`viaMod` is true for uploads sent by the in-game mod (recognised by its `User-Agent`, see `MOD_USER_AGENTS`).",
			fails: [404],
		}),
		(c) => {
			const row = loadRevision(c.var.db, parseId(c.req.param("id")));
			if (!row) return c.json({ error: "not found" }, 404);
			return c.json({ revision: serialize(row, deleteAccess(c)) });
		},
	)
	.get(
		"/:id/tiles",
		doc({
			tag: "Revisions",
			summary: "Tiles an upload covers",
			description:
				"The zoom 0 tiles (`[x, y]`, y along the z axis) the upload put map data in, which outline where it is more closely than its `bbox`. Each spans `tileSize` blocks. Empty for anything that is not a finished upload.",
			fails: [404],
		}),
		async (c) => {
			const { db } = c.var;
			const id = parseId(c.req.param("id"));
			if (!loadRevision(db, id)) return c.json({ error: "not found" }, 404);
			const rows = await db
				.select({ x: uploadPatches.tileX, y: uploadPatches.tileY })
				.from(uploadPatches)
				.where(eq(uploadPatches.revisionId, id));
			const { tileSize } = await loadMap(db);
			return c.json({
				tileSize,
				tiles: rows.map((r) => [r.x, r.y] as [number, number]),
			});
		},
	)
	.get(
		"/:id/events",
		doc({
			tag: "Revisions",
			summary: "Stream a revision's progress",
			description:
				"Server-sent events named after the status (`pending`, `processing`, `done`, `failed`); the stream ends when the revision is done or failed.",
			ok: { 200: "text/event-stream" },
			fails: [404],
		}),
		async (c) => {
			const { db, svc } = c.var;
			const id = parseId(c.req.param("id"));
			if (!loadRevision(db, id)) return c.json({ error: "not found" }, 404);

			return streamSSE(c, async (stream) => {
				let chain: Promise<unknown> = Promise.resolve();
				let finish: () => void = () => {};
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const send = (event: ProgressEvent) => {
					chain = chain.then(() =>
						stream.writeSSE({
							event: event.status,
							data: JSON.stringify(event),
						}),
					);
					if (event.status === "done" || event.status === "failed")
						chain.then(finish);
				};
				const unsubscribe = svc.progress.subscribe(id, send);
				stream.onAbort(() => {
					unsubscribe();
					finish();
				});

				const current = loadRevision(db, id) as RevisionRow;
				send({
					status: current.status,
					rev: current.rev,
					error: current.error,
				});
				const ping = setInterval(() => {
					chain = chain.then(() => stream.write(": ping\n\n"));
				}, 20_000);
				await finished;
				clearInterval(ping);
				unsubscribe();
			});
		},
	)
	/**
	 * Deletes an upload from the map and from all of its history (moderators, or its author for
	 * SELF_DELETE_WINDOW_HOURS after uploading it). It cannot be
	 * undone; the files can simply be uploaded again. A failed upload has nothing to undo and is
	 * just removed; a finished one is erased by a background job.
	 */
	.delete(
		"/:id",
		doc({
			tag: "Revisions",
			summary: "Delete an upload",
			description:
				"Moderators, or the upload's author within `SELF_DELETE_WINDOW_HOURS` of uploading it. Erases the upload from the map and from all of its history; this cannot be undone.",
			ok: {
				200: "A failed upload was removed",
				202: "Being erased in the background",
			},
			fails: [403, 404, 409],
			login: true,
		}),
		requireUser,
		async (c) => {
			const { db, svc } = c.var;
			const id = parseId(c.req.param("id"));
			const [target] = await db
				.select()
				.from(revisions)
				.where(eq(revisions.id, id));
			if (target?.kind !== "upload") {
				return c.json({ error: "not found" }, 404);
			}
			const access = deleteAccess(c);
			if (!canDeleteUpload(userOf(c), c.var.role, target, access.windowMs)) {
				return c.json({ error: "forbidden" }, 403);
			}
			if (target.status === "pending" || target.status === "processing") {
				return c.json({ error: "this upload is still being processed" }, 409);
			}

			if (target.status === "failed") {
				db.transaction((tx) => {
					tx.delete(jobs)
						.where(sql`json_extract(${jobs.payload}, '$.revisionId') = ${id}`)
						.run();
					tx.delete(revisions).where(eq(revisions.id, id)).run();
				});
				return c.json({ ok: true });
			}

			db.transaction((tx) => {
				tx.update(revisions)
					.set({ status: "processing", error: null })
					.where(eq(revisions.id, id))
					.run();
				tx.insert(jobs)
					.values({ type: "erase_upload", payload: { revisionId: id } })
					.run();
			});
			svc.worker.kick();
			return c.json({ ok: true }, 202);
		},
	);

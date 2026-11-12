import { HOUR, type Role } from "@aomc/shared";
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { announceUploads } from "../announce";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { jobs, revisions, uploadPatches, users } from "../db/schema";
import { dimensionBySlug } from "../dimensionLookup";
import type { RevisionEvent } from "../events";
import { erasing } from "../jobs/queue";
import { jobRevisionId } from "../jobs/target";
import { doc } from "../openapi";
import { canDeleteUpload, canModerate, loadMap } from "../permissions";
import { topics } from "../topics";
import type { AppEnv } from "../types";
import { streamTopics } from "./events";
import { parseId } from "./util";

const revisionFields = {
	id: revisions.id,
	rev: revisions.rev,
	kind: revisions.kind,
	dimensionId: revisions.dimensionId,
	authorId: revisions.authorId,
	authorName: users.username,
	status: revisions.status,
	error: revisions.error,
	bboxMinX: revisions.bboxMinX,
	bboxMinZ: revisions.bboxMinZ,
	bboxMaxX: revisions.bboxMaxX,
	bboxMaxZ: revisions.bboxMaxZ,
	fileCount: revisions.fileCount,
	viaMod: revisions.viaMod,
	createdAt: revisions.createdAt,
	exportedAt: revisions.exportedAt,
	completedAt: revisions.completedAt,
};

type RevisionRow = NonNullable<ReturnType<typeof loadRevision>>;

type DeleteAccess = {
	actor: { id: string } | null;
	role: Role;
	readOnly: boolean;
	windowMs: number;
	now: number;
};

function deleteAccess(c: Context<AppEnv>): DeleteAccess {
	return {
		actor: c.var.user,
		role: c.var.role,
		readOnly: c.var.readOnly,
		windowMs: c.var.env.SELF_DELETE_WINDOW_HOURS * HOUR,
		now: Date.now(),
	};
}

function serialize(r: RevisionRow, access: DeleteAccess, deleting: boolean) {
	const { bboxMinX, bboxMinZ, bboxMaxX, bboxMaxZ, ...rest } = r;
	const canDelete =
		r.kind === "upload" &&
		!deleting &&
		!access.readOnly &&
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
	return { ...rest, bbox, canDelete, deletableUntil, deleting };
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
				"`viaMod` is true for uploads sent by the in-game mod (recognised by its `User-Agent`, see `MOD_USER_AGENTS`). Page through older ones with `before`; `nextBefore` is the value for the next page, or null after the last one. `canDelete` says whether you may delete the upload, and `deletableUntil` when that ends for your own uploads (null = no limit or not yours). `deleting` is true while a delete of the upload is queued or running.",
			query: {
				limit: "At most this many (1 to 1000, default 200)",
				before: "Only revisions with a smaller id (for paging)",
				dimension: "Only revisions in this dimension (slug)",
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
				const dim = dimensionBySlug(db, slug);
				if (!dim) return c.json({ error: "not found" }, 404);
				filters.push(eq(revisions.dimensionId, dim.id));
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
			const all = [...rows, ...extra];
			const pending = erasing(
				db,
				all.map((r) => r.id),
			);
			return c.json({
				revisions: all
					.sort((a, b) => b.id - a.id)
					.map((r) => serialize(r, access, pending.has(r.id))),
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
			const deleting = erasing(c.var.db, [row.id]).has(row.id);
			return c.json({ revision: serialize(row, deleteAccess(c), deleting) });
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
				"The `revision:<id>` topic of `GET /api/events` on its own, as server-sent events named after the status (`pending`, `processing`, `done`, `failed`, `gone`); the stream ends when the revision is done, failed or gone (an erased upload ends with `gone`). The first event is the current status (for a queued job with a `message` that says what it waits for, repeated when that changes); for an upload whose delete is waiting in the queue it is `processing` with a `message` that says what it waits for.",
			ok: { 200: "text/event-stream" },
			fails: [404],
		}),
		async (c) => {
			const { db } = c.var;
			const id = parseId(c.req.param("id"));
			if (!loadRevision(db, id)) return c.json({ error: "not found" }, 404);

			return streamTopics(c, [`revision:${id}`], (stream, envelope) =>
				"error" in envelope
					? Promise.resolve()
					: stream.writeSSE({
							event: topics.revision.name(envelope.data as RevisionEvent),
							data: JSON.stringify(envelope.data),
						}),
			);
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
					tx.delete(jobs).where(eq(jobRevisionId, id)).run();
					tx.delete(revisions).where(eq(revisions.id, id)).run();
				});
				svc.events.emit("revision", id, { status: "gone" });
				announceUploads(c, target.dimensionId);
				svc.worker.kick();
				return c.json({ ok: true });
			}

			if (erasing(db, [id]).has(id)) {
				return c.json({ error: "this upload is already being deleted" }, 409);
			}
			// The upload keeps its status until the erase job starts, so the jobs queued before it
			// still see it as part of the map.
			db.transaction((tx) => {
				tx.update(revisions)
					.set({ error: null })
					.where(eq(revisions.id, id))
					.run();
				tx.insert(jobs)
					.values({ type: "erase_upload", payload: { revisionId: id } })
					.run();
			});
			announceUploads(c, target.dimensionId);
			svc.worker.kick();
			return c.json({ ok: true }, 202);
		},
	);

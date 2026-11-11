import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireUser } from "../auth/session";
import type { Db } from "../db/client";
import { jobs, revisions, users } from "../db/schema";
import { doc } from "../openapi";
import { canModerate } from "../permissions";
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

function serialize(r: RevisionRow) {
	const { bboxMinX, bboxMinZ, bboxMaxX, bboxMaxZ, ...rest } = r;
	const bbox =
		bboxMinX === null ||
		bboxMinZ === null ||
		bboxMaxX === null ||
		bboxMaxZ === null
			? null
			: { minX: bboxMinX, minZ: bboxMinZ, maxX: bboxMaxX, maxZ: bboxMaxZ };
	return { ...rest, bbox };
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
				"`viaMod` is true for uploads sent by the in-game mod (recognised by its `User-Agent`, see `MOD_USER_AGENTS`).",
			query: { limit: "At most this many (1 to 1000, default 200)" },
		}),
		async (c) => {
			const limit = Math.min(
				Math.max(Number(c.req.query("limit")) || 200, 1),
				1000,
			);
			const rows = await c.var.db
				.select(revisionFields)
				.from(revisions)
				.innerJoin(users, eq(users.id, revisions.authorId))
				.orderBy(desc(revisions.id))
				.limit(limit);
			return c.json({ revisions: rows.map(serialize) });
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
			return c.json({ revision: serialize(row) });
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
	 * Deletes an upload from the map and from all of its history (moderators). It cannot be
	 * undone; the files can simply be uploaded again. A failed upload has nothing to undo and is
	 * just removed; a finished one is erased by a background job.
	 */
	.delete(
		"/:id",
		doc({
			tag: "Revisions",
			summary: "Delete an upload",
			description:
				"Moderators. Erases the upload from the map and from all of its history; this cannot be undone.",
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
			if (!canModerate(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const id = parseId(c.req.param("id"));
			const [target] = await db
				.select()
				.from(revisions)
				.where(eq(revisions.id, id));
			if (target?.kind !== "upload") {
				return c.json({ error: "not found" }, 404);
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

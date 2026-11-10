import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireUser } from "../auth/session";
import type { Db } from "../db/client";
import { jobs, revisions, users } from "../db/schema";
import { canModerate, loadMapAccess, loadMapAccessById } from "../permissions";
import type { ProgressEvent } from "../progress";
import type { AppEnv } from "../types";

const revisionFields = {
	id: revisions.id,
	mapId: revisions.mapId,
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
	reverted: revisions.reverted,
	createdAt: revisions.createdAt,
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

const parseId = (value: string | undefined) =>
	/^\d+$/.test(value ?? "") ? Number(value) : NaN;

/** GET /api/maps/:slug/revisions: newest first, for the history panel. */
export const mapRevisionRoutes = new Hono<AppEnv>().get("/", async (c) => {
	const access = await loadMapAccess(
		c.var.db,
		c.var.user,
		c.req.param("slug") ?? "",
	);
	if (!access) return c.json({ error: "not found" }, 404);
	const limit = Math.min(
		Math.max(Number(c.req.query("limit")) || 200, 1),
		1000,
	);
	const rows = await c.var.db
		.select(revisionFields)
		.from(revisions)
		.innerJoin(users, eq(users.id, revisions.authorId))
		.where(eq(revisions.mapId, access.map.id))
		.orderBy(desc(revisions.id))
		.limit(limit);
	return c.json({ revisions: rows.map(serialize) });
});

export const revisionRoutes = new Hono<AppEnv>()
	.get("/:id", async (c) => {
		const row = loadRevision(c.var.db, parseId(c.req.param("id")));
		const access =
			row && (await loadMapAccessById(c.var.db, c.var.user, row.mapId));
		if (!row || !access) return c.json({ error: "not found" }, 404);
		return c.json({ revision: serialize(row) });
	})
	.get("/:id/events", async (c) => {
		const { db, svc } = c.var;
		const id = parseId(c.req.param("id"));
		const row = loadRevision(db, id);
		const access = row && (await loadMapAccessById(db, c.var.user, row.mapId));
		if (!row || !access) return c.json({ error: "not found" }, 404);

		return streamSSE(c, async (stream) => {
			let chain: Promise<unknown> = Promise.resolve();
			let finish: () => void = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const send = (event: ProgressEvent) => {
				chain = chain.then(() =>
					stream.writeSSE({ event: event.status, data: JSON.stringify(event) }),
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
			send({ status: current.status, rev: current.rev, error: current.error });
			const ping = setInterval(() => {
				chain = chain.then(() => stream.write(": ping\n\n"));
			}, 20_000);
			await finished;
			clearInterval(ping);
			unsubscribe();
		});
	})
	.post("/:id/revert", requireUser, (c) => startRevert(c, "revert"))
	.post("/:id/unrevert", requireUser, (c) => startRevert(c, "unrevert"));

async function startRevert(
	c: import("hono").Context<AppEnv>,
	kind: "revert" | "unrevert",
) {
	const { db, svc } = c.var;
	const user = c.var.user as NonNullable<typeof c.var.user>;
	const targetId = parseId(c.req.param("id"));
	const [target] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, targetId));
	const access = target && (await loadMapAccessById(db, user, target.mapId));
	if (!target || !access) return c.json({ error: "not found" }, 404);
	if (!canModerate(access.role)) return c.json({ error: "forbidden" }, 403);
	if (target.kind !== "upload" || target.status !== "done") {
		return c.json({ error: "only finished uploads can be reverted" }, 400);
	}
	if (target.reverted !== (kind === "unrevert")) {
		return c.json(
			{ error: kind === "revert" ? "already reverted" : "not reverted" },
			409,
		);
	}
	const [inFlight] = await db
		.select({ id: revisions.id })
		.from(revisions)
		.where(
			and(
				eq(revisions.targetRevisionId, targetId),
				inArray(revisions.status, ["pending", "processing"]),
			),
		);
	if (inFlight)
		return c.json({ error: "another revert is already pending" }, 409);

	const created = db.transaction((tx) => {
		const revision = tx
			.insert(revisions)
			.values({
				mapId: target.mapId,
				kind,
				dimensionId: target.dimensionId,
				authorId: user.id,
				targetRevisionId: targetId,
			})
			.returning({ id: revisions.id })
			.get();
		tx.insert(jobs)
			.values({
				type: "apply_revert",
				payload: { revisionId: revision.id, targetId },
			})
			.run();
		return revision;
	});
	svc.worker.kick();
	return c.json({ revisionId: created.id }, 202);
}

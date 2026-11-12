import { and, asc, between, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
	jobs,
	mapInfo,
	revisions,
	tileVersions,
	uploadPatches,
} from "../db/schema";
import type { TileWrite } from "./pyramid";

export type Bbox = { minX: number; minZ: number; maxX: number; maxZ: number };

/** Latest version of a tile at or before `rev`. undefined = never written; blobHash null = empty. */
export async function tileVersionAt(
	db: Db,
	dimensionId: number,
	zoom: number,
	x: number,
	y: number,
	rev: number,
): Promise<{ blobHash: string | null } | undefined> {
	const [row] = await db
		.select({ blobHash: tileVersions.blobHash })
		.from(tileVersions)
		.where(
			and(
				eq(tileVersions.dimensionId, dimensionId),
				eq(tileVersions.zoom, zoom),
				eq(tileVersions.tileX, x),
				eq(tileVersions.tileY, y),
				lte(tileVersions.rev, rev),
			),
		)
		.orderBy(desc(tileVersions.rev))
		.limit(1);
	return row;
}

/** Non-empty tiles in a rectangle (inclusive) as of `rev`. Tiles not listed are empty. */
export async function tileHashesIn(
	db: Db,
	dimensionId: number,
	zoom: number,
	rect: { minX: number; minY: number; maxX: number; maxY: number },
	rev: number,
): Promise<{ x: number; y: number; hash: string }[]> {
	// SQLite takes the bare columns of an aggregate query from the row that has the max().
	const rows = await db
		.select({
			x: tileVersions.tileX,
			y: tileVersions.tileY,
			hash: tileVersions.blobHash,
			rev: sql<number>`max(${tileVersions.rev})`,
		})
		.from(tileVersions)
		.where(
			and(
				eq(tileVersions.dimensionId, dimensionId),
				eq(tileVersions.zoom, zoom),
				between(tileVersions.tileX, rect.minX, rect.maxX),
				between(tileVersions.tileY, rect.minY, rect.maxY),
				lte(tileVersions.rev, rev),
			),
		)
		.groupBy(tileVersions.tileX, tileVersions.tileY);
	return rows.flatMap((r) =>
		r.hash ? [{ x: r.x, y: r.y, hash: r.hash }] : [],
	);
}

export async function tileHashAt(
	db: Db,
	dimensionId: number,
	zoom: number,
	x: number,
	y: number,
	rev: number,
): Promise<string | null> {
	return (
		(await tileVersionAt(db, dimensionId, zoom, x, y, rev))?.blobHash ?? null
	);
}

/** When an upload counts as made: its export time, or else when it was uploaded. */
export const effectiveTime = sql<number>`coalesce(${revisions.exportedAt}, ${revisions.createdAt})`;

export type TilePatch = {
	id: number;
	hash: string;
	/** `effectiveTime` of the upload. */
	at: number;
};

/** The order overlapping patches are stacked in: oldest export first, upload order breaking ties. */
export const stackOrder = (
	a: { at: number; id: number },
	b: { at: number; id: number },
) => a.at - b.at || a.id - b.id;

/**
 * Every patch of every finished upload that touched a tile, oldest first. Overlapping patches
 * are applied in this order, so the newest export is on top however late it was uploaded.
 */
export function tilePatches(
	db: Db,
	dimensionId: number,
	x: number,
	y: number,
): Promise<TilePatch[]> {
	return db
		.select({
			id: revisions.id,
			hash: uploadPatches.blobHash,
			at: effectiveTime,
		})
		.from(uploadPatches)
		.innerJoin(revisions, eq(revisions.id, uploadPatches.revisionId))
		.where(
			and(
				eq(revisions.dimensionId, dimensionId),
				eq(revisions.kind, "upload"),
				eq(revisions.status, "done"),
				eq(uploadPatches.tileX, x),
				eq(uploadPatches.tileY, y),
			),
		)
		.orderBy(asc(effectiveTime), asc(revisions.id));
}

/**
 * Publishes a finished revision atomically: tile versions, patches, the revision row and the
 * map's head_rev all become visible together, or not at all. The job that made it (`jobId`)
 * is marked done in the same transaction, so a crash can never leave a published revision
 * with a job that would run again.
 */
export function commitRevision(
	db: Db,
	opts: {
		revisionId: number;
		jobId?: number;
		rev: number;
		dimensionId: number;
		writes: TileWrite[];
		patches?: { x: number; y: number; hash: string }[];
		bbox: Bbox | null;
	},
) {
	const { revisionId, rev, dimensionId } = opts;
	db.transaction((tx) => {
		const map = tx.select({ headRev: mapInfo.headRev }).from(mapInfo).get();
		if (!map || map.headRev !== rev - 1)
			throw new Error("map head moved during processing");

		for (let i = 0; i < opts.writes.length; i += 500) {
			const chunk = opts.writes.slice(i, i + 500);
			tx.insert(tileVersions)
				.values(
					chunk.map((w) => ({
						dimensionId,
						zoom: w.zoom,
						tileX: w.x,
						tileY: w.y,
						rev,
						blobHash: w.hash,
					})),
				)
				.run();
		}
		const patches = opts.patches ?? [];
		for (let i = 0; i < patches.length; i += 500) {
			tx.insert(uploadPatches)
				.values(
					patches.slice(i, i + 500).map((p) => ({
						revisionId,
						tileX: p.x,
						tileY: p.y,
						blobHash: p.hash,
					})),
				)
				.run();
		}
		tx.update(revisions)
			.set({
				rev,
				status: "done",
				error: null,
				completedAt: Date.now(),
				bboxMinX: opts.bbox?.minX ?? null,
				bboxMinZ: opts.bbox?.minZ ?? null,
				bboxMaxX: opts.bbox?.maxX ?? null,
				bboxMaxZ: opts.bbox?.maxZ ?? null,
			})
			.where(eq(revisions.id, revisionId))
			.run();
		tx.update(mapInfo).set({ headRev: rev }).run();
		if (opts.jobId !== undefined) {
			tx.update(jobs)
				.set({ status: "done" })
				.where(eq(jobs.id, opts.jobId))
				.run();
		}
	});
}

/** Whether a revision was already published: done, with its revision number. */
export function isPublished(db: Db, revisionId: number): boolean {
	const row = db
		.select({ status: revisions.status, rev: revisions.rev })
		.from(revisions)
		.where(eq(revisions.id, revisionId))
		.get();
	return row?.status === "done" && row.rev !== null;
}

import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { maps, revisions, tileVersions, uploadPatches } from "../db/schema";
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

/**
 * Publishes a finished revision atomically: tile versions, patches, the revision row and the
 * map's head_rev all become visible together, or not at all.
 */
export function commitRevision(
	db: Db,
	opts: {
		mapId: number;
		revisionId: number;
		rev: number;
		dimensionId: number;
		writes: TileWrite[];
		patches?: { x: number; y: number; hash: string }[];
		bbox: Bbox | null;
		setReverted?: { revisionId: number; reverted: boolean };
	},
) {
	const { mapId, revisionId, rev, dimensionId } = opts;
	db.transaction((tx) => {
		const map = tx
			.select({ headRev: maps.headRev })
			.from(maps)
			.where(eq(maps.id, mapId))
			.get();
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
		if (opts.setReverted) {
			tx.update(revisions)
				.set({ reverted: opts.setReverted.reverted })
				.where(eq(revisions.id, opts.setReverted.revisionId))
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
		tx.update(maps).set({ headRev: rev }).where(eq(maps.id, mapId)).run();
	});
}

export async function failRevision(
	db: Db,
	revisionId: number,
	message: string,
) {
	await db
		.update(revisions)
		.set({
			status: "failed",
			error: message.slice(0, 500),
			completedAt: Date.now(),
		})
		.where(eq(revisions.id, revisionId));
}

import { and, eq } from "drizzle-orm";
import { maps, revisions, uploadPatches } from "../db/schema";
import { emptyTile, loadTile, overRegion, storeTile } from "../tiles/compose";
import { commitRevision, tileHashAt } from "../tiles/history";
import { buildPyramid, type TileWrite, tileKey } from "../tiles/pyramid";
import type { ApplyRevertPayload, JobContext } from "./types";

/**
 * Reverts or unreverts an upload. History is never rewritten: this publishes a new revision
 * whose tile versions reflect the new effective set of uploads.
 *
 * Each affected tile is rebuilt from scratch by replaying, in rev order, every patch of every
 * done upload that is not reverted. (Starting from the tile as it was just before the target
 * would resurrect uploads that were reverted later.)
 */
export async function applyRevert(
	ctx: JobContext,
	payload: ApplyRevertPayload,
) {
	const { db, env, blobs, progress } = ctx;
	const [op] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, payload.revisionId));
	const [target] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, payload.targetId));
	if (!op || !target || target.kind !== "upload" || target.status !== "done") {
		throw new Error("target revision is not a finished upload");
	}
	const nowReverted = op.kind === "revert";
	if (target.reverted === nowReverted) {
		throw new Error(
			nowReverted ? "upload is already reverted" : "upload is not reverted",
		);
	}
	const dimensionId = target.dimensionId as number;
	const [map] = await db.select().from(maps).where(eq(maps.id, target.mapId));
	if (!map) throw new Error("map not found");
	const T = map.tileSize;
	const head = map.headRev;

	const targetTiles = await db
		.select({ x: uploadPatches.tileX, y: uploadPatches.tileY })
		.from(uploadPatches)
		.where(eq(uploadPatches.revisionId, target.id));

	const changed = new Map<string, string | null>();
	const writes: TileWrite[] = [];
	let n = 0;
	for (const { x, y } of targetTiles) {
		const patches = await db
			.select({
				id: revisions.id,
				reverted: revisions.reverted,
				hash: uploadPatches.blobHash,
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
			.orderBy(revisions.rev);

		const canvas = emptyTile(T);
		for (const p of patches) {
			const reverted = p.id === target.id ? nowReverted : p.reverted;
			if (!reverted)
				overRegion(canvas, T, await loadTile(blobs, p.hash, T), T, T, 0, 0);
		}
		const hash = await storeTile(blobs, canvas, T);
		const current = await tileHashAt(db, dimensionId, 0, x, y, head);
		if (hash !== current) {
			changed.set(tileKey(x, y), hash);
			writes.push({ zoom: 0, x, y, hash });
		}
		progress.emit(op.id, {
			status: "processing",
			message: "rebuilding tiles",
			done: ++n,
			total: targetTiles.length,
		});
	}

	writes.push(
		...(await buildPyramid({
			blobs,
			tileSize: T,
			maxZoom: env.MAX_ZOOM,
			changed,
			current: (zoom, x, y) => tileHashAt(db, dimensionId, zoom, x, y, head),
		})),
	);

	const hasBbox = target.bboxMinX !== null;
	commitRevision(db, {
		mapId: map.id,
		revisionId: op.id,
		rev: head + 1,
		dimensionId,
		writes,
		bbox: hasBbox
			? {
					minX: target.bboxMinX as number,
					minZ: target.bboxMinZ as number,
					maxX: target.bboxMaxX as number,
					maxZ: target.bboxMaxZ as number,
				}
			: null,
		setReverted: { revisionId: target.id, reverted: nowReverted },
	});
}

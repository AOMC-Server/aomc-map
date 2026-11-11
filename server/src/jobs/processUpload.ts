import { floorDiv } from "@aomc/shared";
import { eq } from "drizzle-orm";
import { dimensions, revisions } from "../db/schema";
import { loadMap } from "../permissions";
import {
	decodeRaw,
	emptyTile,
	loadTile,
	overRegion,
	storeTile,
} from "../tiles/compose";
import {
	type Bbox,
	commitRevision,
	stackOrder,
	tileHashAt,
	tilePatches,
} from "../tiles/history";
import { buildPyramid, type TileWrite, tileKey } from "../tiles/pyramid";
import { blackToAlpha } from "../tiles/xaero";
import {
	incomingDir,
	type JobContext,
	type ProcessUploadPayload,
	UserError,
} from "./types";

/** Memory for the tile canvases held at once while the source files are pasted in. */
const BATCH_BYTES = 64 * 1024 * 1024;

export async function processUpload(
	ctx: JobContext,
	payload: ProcessUploadPayload,
	jobId?: number,
	batchBytes = BATCH_BYTES,
) {
	const { db, env, blobs, progress } = ctx;
	const { revisionId, files } = payload;
	const say = (message: string, done?: number, total?: number) =>
		progress.emit(revisionId, { status: "processing", message, done, total });

	const [revision] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, revisionId));
	if (!revision || revision.dimensionId === null)
		throw new Error("revision not found");
	const map = await loadMap(db);
	const [dim] = await db
		.select()
		.from(dimensions)
		.where(eq(dimensions.id, revision.dimensionId));
	if (!dim) throw new Error("dimension not found");
	const T = map.tileSize;
	const head = map.headRev;

	// Which files touch which zoom 0 tile (tile_y indexes the z axis).
	const byTile = new Map<string, { tx: number; ty: number; files: number[] }>();
	files.forEach((f, index) => {
		for (
			let ty = floorDiv(f.z, T);
			ty <= floorDiv(f.z + f.height - 1, T);
			ty++
		) {
			for (
				let tx = floorDiv(f.x, T);
				tx <= floorDiv(f.x + f.width - 1, T);
				tx++
			) {
				const key = tileKey(tx, ty);
				const entry = byTile.get(key) ?? { tx, ty, files: [] };
				entry.files.push(index);
				byTile.set(key, entry);
			}
		}
	});

	// One patch per touched tile, files pasted in upload order. Tiles are done in batches to
	// bound memory; within a batch each file is decoded once and pasted into every tile it covers.
	const patches: { x: number; y: number; hash: string }[] = [];
	const tiles = [...byTile.values()];
	const batchSize = Math.max(1, Math.floor(batchBytes / (T * T * 4)));
	let n = 0;
	for (let start = 0; start < tiles.length; start += batchSize) {
		const batch = tiles.slice(start, start + batchSize);
		const canvases = batch.map(() => emptyTile(T));
		const covered = new Map<number, number[]>();
		for (const [b, tile] of batch.entries()) {
			for (const index of tile.files) {
				covered.set(index, [...(covered.get(index) ?? []), b]);
			}
		}
		for (const index of [...covered.keys()].sort((a, b) => a - b)) {
			const f = files[index] as (typeof files)[number];
			const img = await decodeRaw(
				`${incomingDir(env, revisionId)}/${index}.png`,
				env.MAX_IMAGE_DIM,
			);
			blackToAlpha(img.data);
			for (const b of covered.get(index) as number[]) {
				const { tx, ty } = batch[b] as (typeof batch)[number];
				overRegion(
					canvases[b] as Buffer,
					T,
					img.data,
					img.width,
					img.height,
					f.x - tx * T,
					f.z - ty * T,
				);
			}
		}
		for (const [b, { tx, ty }] of batch.entries()) {
			const hash = await storeTile(blobs, canvases[b] as Buffer, T);
			if (hash) patches.push({ x: tx, y: ty, hash });
			say("building patches", ++n, tiles.length);
		}
	}
	if (patches.length === 0) throw new UserError("upload contains no map data");

	// Composite each patch into its tile. Normally that is over the tile as of the current head;
	// but if an export made later than this one already covers the tile, this (older) export
	// goes underneath it, so the tile is replayed from every patch in export order.
	const exportedAt = revision.exportedAt ?? revision.createdAt;
	const changed = new Map<string, string | null>();
	const writes: TileWrite[] = [];
	n = 0;
	for (const p of patches) {
		const current = await tileHashAt(db, dim.id, 0, p.x, p.y, head);
		const live = (await tilePatches(db, dim.id, p.x, p.y)).filter(
			(q) => !q.reverted,
		);
		let canvas: Buffer;
		if (
			live.some(
				(q) => q.at > exportedAt || (q.at === exportedAt && q.id > revisionId),
			)
		) {
			const stack = [...live, { id: revisionId, at: exportedAt, hash: p.hash }];
			stack.sort(stackOrder);
			canvas = emptyTile(T);
			for (const q of stack) {
				overRegion(canvas, T, await loadTile(blobs, q.hash, T), T, T, 0, 0);
			}
		} else {
			canvas = current ? await loadTile(blobs, current, T) : emptyTile(T);
			overRegion(canvas, T, await loadTile(blobs, p.hash, T), T, T, 0, 0);
		}
		const hash = await storeTile(blobs, canvas, T);
		if (hash !== current) {
			changed.set(tileKey(p.x, p.y), hash);
			writes.push({ zoom: 0, x: p.x, y: p.y, hash });
		}
		say("compositing tiles", ++n, patches.length);
	}

	say("building zoom levels");
	writes.push(
		...(await buildPyramid({
			blobs,
			tileSize: T,
			maxZoom: env.MAX_ZOOM,
			changed,
			current: (zoom, x, y) => tileHashAt(db, dim.id, zoom, x, y, head),
		})),
	);

	const bbox: Bbox = {
		minX: Math.min(...files.map((f) => f.x)),
		minZ: Math.min(...files.map((f) => f.z)),
		maxX: Math.max(...files.map((f) => f.x + f.width - 1)),
		maxZ: Math.max(...files.map((f) => f.z + f.height - 1)),
	};
	say("publishing");
	commitRevision(db, {
		revisionId,
		jobId,
		rev: head + 1,
		dimensionId: dim.id,
		writes,
		patches,
		bbox,
	});
}

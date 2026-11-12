import { floorDiv } from "@aomc/shared";
import { eq } from "drizzle-orm";
import { mapLimit } from "../concurrency";
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
import { messages } from "./messages";
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

	// Composites a patch into its tile. Normally that is over the tile as of the current head;
	// but if an export made later than this one already covers the tile, this (older) export
	// goes underneath it, so the tile is replayed from every patch in export order. `patch` is
	// the patch's image as stored (with the hash `hash`), still in memory.
	const exportedAt = revision.exportedAt ?? revision.createdAt;
	const composite = async (
		x: number,
		y: number,
		hash: string,
		patch: Buffer,
	): Promise<{ current: string | null; result: string | null }> => {
		const current = await tileHashAt(db, dim.id, 0, x, y, head);
		const live = await tilePatches(db, dim.id, x, y);
		let canvas: Buffer;
		if (
			live.some(
				(q) => q.at > exportedAt || (q.at === exportedAt && q.id > revisionId),
			)
		) {
			const stack = [...live, { id: revisionId, at: exportedAt, hash }];
			stack.sort(stackOrder);
			canvas = emptyTile(T);
			for (const q of stack) {
				const image =
					q.id === revisionId ? patch : await loadTile(blobs, q.hash, T);
				overRegion(canvas, T, image, T, T, 0, 0);
			}
		} else if (current === null) {
			// Over an empty tile the result is the patch itself.
			return { current, result: hash };
		} else {
			canvas = await loadTile(blobs, current, T);
			overRegion(canvas, T, patch, T, T, 0, 0);
		}
		return { current, result: await storeTile(blobs, canvas, T) };
	};

	// One patch per touched tile, files pasted in upload order, and composited into its tile
	// while it is still in memory. Tiles are done in batches to bound memory; within a batch each
	// file is decoded once and pasted into every tile it covers, and the tiles are then encoded
	// several at once.
	const patches: { x: number; y: number; hash: string }[] = [];
	const changed = new Map<string, string | null>();
	const writes: TileWrite[] = [];
	const tiles = [...byTile.values()];
	const batchSize = Math.max(1, Math.floor(batchBytes / (T * T * 4)));
	let n = 0;
	// Decoding a source image can take a while and nothing else is reported meanwhile, so it
	// counts as progress too: how many images each batch reads, in total.
	let reads = 0;
	for (let start = 0; start < tiles.length; start += batchSize) {
		reads += new Set(
			tiles.slice(start, start + batchSize).flatMap((tile) => tile.files),
		).size;
	}
	let read = 0;
	for (let start = 0; start < tiles.length; start += batchSize) {
		const batch = tiles.slice(start, start + batchSize);
		const canvases = batch.map(() => emptyTile(T));
		const covered = new Map<number, number[]>();
		for (const [b, tile] of batch.entries()) {
			for (const index of tile.files) {
				const list = covered.get(index) ?? [];
				list.push(b);
				covered.set(index, list);
			}
		}
		for (const index of [...covered.keys()].sort((a, b) => a - b)) {
			const f = files[index] as (typeof files)[number];
			say(messages.upload.reading, read++, reads);
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
		const done = await mapLimit(
			batch,
			env.JOB_CONCURRENCY,
			async ({ tx, ty }, b) => {
				// Storing zeroes the colour under transparent pixels, so `patch` is then exactly
				// what the stored patch decodes to.
				const patch = canvases[b] as Buffer;
				const hash = await storeTile(blobs, patch, T);
				const tile = hash ? await composite(tx, ty, hash, patch) : null;
				say(messages.upload.tiles, ++n, tiles.length);
				return tile && hash ? { x: tx, y: ty, hash, ...tile } : null;
			},
		);
		for (const tile of done) {
			if (!tile) continue;
			patches.push({ x: tile.x, y: tile.y, hash: tile.hash });
			if (tile.result !== tile.current) {
				changed.set(tileKey(tile.x, tile.y), tile.result);
				writes.push({ zoom: 0, x: tile.x, y: tile.y, hash: tile.result });
			}
		}
	}
	if (patches.length === 0) throw new UserError("upload contains no map data");

	writes.push(
		...(await buildPyramid({
			blobs,
			tileSize: T,
			maxZoom: env.MAX_ZOOM,
			changed,
			current: (zoom, x, y) => tileHashAt(db, dim.id, zoom, x, y, head),
			concurrency: env.JOB_CONCURRENCY,
			onProgress: (zoom, done, total) =>
				say(messages.upload.zoom(zoom), done, total),
		})),
	);

	const bbox: Bbox = {
		minX: Math.min(...files.map((f) => f.x)),
		minZ: Math.min(...files.map((f) => f.z)),
		maxX: Math.max(...files.map((f) => f.x + f.width - 1)),
		maxZ: Math.max(...files.map((f) => f.z + f.height - 1)),
	};
	say(messages.upload.publishing);
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

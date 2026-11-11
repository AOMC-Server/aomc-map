import { and, between, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { uploadPatches } from "../db/schema";
import type { BlobStore } from "./blobstore";
import { composeParent, encodeTile, loadTile } from "./compose";

type Patch = { x: number; y: number; hash: string };

/** The tile of one upload alone at zoom 0: its patch, or null where it did not reach. */
export async function patchHash(
	db: Db,
	revisionId: number,
	x: number,
	y: number,
): Promise<string | null> {
	const [row] = await db
		.select({ hash: uploadPatches.blobHash })
		.from(uploadPatches)
		.where(
			and(
				eq(uploadPatches.revisionId, revisionId),
				eq(uploadPatches.tileX, x),
				eq(uploadPatches.tileY, y),
			),
		);
	return row?.hash ?? null;
}

async function render(
	blobs: BlobStore,
	tileSize: number,
	zoom: number,
	x: number,
	y: number,
	patches: Patch[],
): Promise<Buffer | null> {
	if (patches.length === 0) return null;
	if (zoom === 0) return loadTile(blobs, (patches[0] as Patch).hash, tileSize);
	const children: (Buffer | null)[] = [];
	const span = 2 ** (zoom - 1);
	for (let q = 0; q < 4; q++) {
		const cx = 2 * x + (q % 2);
		const cy = 2 * y + Math.floor(q / 2);
		const inside = patches.filter(
			(p) =>
				p.x >= cx * span &&
				p.x < (cx + 1) * span &&
				p.y >= cy * span &&
				p.y < (cy + 1) * span,
		);
		// Patches are indexed by zoom 0 tile, so narrow them to this child's area.
		children.push(await render(blobs, tileSize, zoom - 1, cx, cy, inside));
	}
	return composeParent(tileSize, children);
}

const CACHE_MAX = 400;
/** Per blob store, so separate data directories never share results. */
const caches = new WeakMap<BlobStore, Map<string, Buffer | null>>();

/**
 * A zoomed-out tile (zoom > 0) of one upload alone, as WebP, built from its patches the way the
 * map's own pyramid is. Nothing is stored: these are not part of any revision. Null = empty.
 * An upload's patches never change, so results can be cached for good.
 */
export async function isolatedTile(
	db: Db,
	blobs: BlobStore,
	tileSize: number,
	revisionId: number,
	zoom: number,
	x: number,
	y: number,
): Promise<Buffer | null> {
	let cache = caches.get(blobs);
	if (!cache) {
		cache = new Map();
		caches.set(blobs, cache);
	}
	const key = `${tileSize}:${revisionId}:${zoom}:${x}:${y}`;
	if (cache.has(key)) return cache.get(key) ?? null;

	const span = 2 ** zoom;
	const rows = await db
		.select({
			x: uploadPatches.tileX,
			y: uploadPatches.tileY,
			hash: uploadPatches.blobHash,
		})
		.from(uploadPatches)
		.where(
			and(
				eq(uploadPatches.revisionId, revisionId),
				between(uploadPatches.tileX, x * span, (x + 1) * span - 1),
				between(uploadPatches.tileY, y * span, (y + 1) * span - 1),
			),
		);
	const raw = await render(blobs, tileSize, zoom, x, y, rows);
	const webp = raw ? await encodeTile(raw, tileSize) : null;

	if (cache.size >= CACHE_MAX) {
		cache.delete(cache.keys().next().value as string);
	}
	cache.set(key, webp);
	return webp;
}

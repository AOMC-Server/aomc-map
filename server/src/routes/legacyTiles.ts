import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import sharp from "sharp";
import { dimensionBySlug } from "../dimensionLookup";
import { doc } from "../openapi";
import { loadMap } from "../permissions";
import type { BlobStore } from "../tiles/blobstore";
import {
	composeParent,
	emptyTile,
	isEmpty,
	loadTile,
	overRegion,
} from "../tiles/compose";
import { tileHashesIn } from "../tiles/history";
import { tileKey } from "../tiles/pyramid";
import type { AppEnv } from "../types";

/** v1 tiles were 512 pixels whatever the map's tile size is now. */
export const LEGACY_TILE_SIZE = 512;
/** v1 built zoom levels 0 to 9. */
export const LEGACY_MAX_ZOOM = 9;
/** Levels above MAX_ZOOM that are made on the fly; each one takes 4x the stored tiles. */
const MAX_EXTRA_LEVELS = 2;
/** Most stored tiles one v1 tile is made from (small tile sizes need many). */
const MAX_SOURCE_TILES = 256;
const TILE_NAME = /^(-?\d+)_(-?\d+)\.png$/;
const CACHE_MAX = 200;
/** Per blob store, so separate data directories never share results. */
const caches = new WeakMap<BlobStore, Map<string, Buffer>>();

type Source = { x: number; y: number; hash: string };

const notFound = (c: Context<AppEnv>) => c.json({ error: "not found" }, 404);

async function sendPng(
	c: Context<AppEnv>,
	etag: string,
	body: () => Promise<Blob | Buffer | null>,
) {
	const headers = { ETag: etag, "Cache-Control": "public, max-age=10" };
	if (c.req.header("If-None-Match") === etag)
		return new Response(null, { status: 304, headers });
	const data = await body();
	if (!data) return notFound(c);
	return new Response(data as BodyInit, {
		headers: {
			...headers,
			"Content-Type": "image/png",
			"Content-Length": String(
				data instanceof Blob ? data.size : data.byteLength,
			),
		},
	});
}

/**
 * A tile `levels` above the stored ones, halved down from them the way the pyramid is built.
 * `sources` are indexed relative to its top-left source tile; null when there are none.
 */
async function composeAbove(
	blobs: BlobStore,
	tileSize: number,
	levels: number,
	sources: Source[],
): Promise<Buffer | null> {
	let level = new Map<string, Buffer>(
		await Promise.all(
			sources.map(
				async (t) =>
					[tileKey(t.x, t.y), await loadTile(blobs, t.hash, tileSize)] as const,
			),
		),
	);
	for (let size = 2 ** levels; size > 1; size /= 2) {
		const next = new Map<string, Buffer>();
		for (let py = 0; py < size / 2; py++) {
			for (let px = 0; px < size / 2; px++) {
				const parent = composeParent(
					tileSize,
					[0, 1, 2, 3].map((q) =>
						level.get(tileKey(2 * px + (q % 2), 2 * py + Math.floor(q / 2))),
					),
				);
				if (parent) next.set(tileKey(px, py), parent);
			}
		}
		level = next;
	}
	return level.get(tileKey(0, 0)) ?? null;
}

/**
 * The v1 tile whose top-left pixel is (left, top) at `zoom`: the map's tiles at that zoom
 * (made from `sources`, `levels` below it, when it is above MAX_ZOOM) cropped and stitched to
 * v1's size, as an opaque PNG. Null when that area is empty.
 */
async function renderLegacy(
	blobs: BlobStore,
	tileSize: number,
	levels: number,
	left: number,
	top: number,
	sources: Source[],
): Promise<Buffer | null> {
	const n = 2 ** levels;
	const byTile = new Map<string, Source[]>();
	for (const s of sources) {
		const key = tileKey(Math.floor(s.x / n), Math.floor(s.y / n));
		byTile.set(key, [...(byTile.get(key) ?? []), s]);
	}
	const canvas = emptyTile(LEGACY_TILE_SIZE);
	for (const [key, group] of byTile) {
		const [tx, ty] = key.split(",").map(Number) as [number, number];
		const raw = await composeAbove(
			blobs,
			tileSize,
			levels,
			group.map((s) => ({ x: s.x - tx * n, y: s.y - ty * n, hash: s.hash })),
		);
		if (!raw) continue;
		overRegion(
			canvas,
			LEGACY_TILE_SIZE,
			raw,
			tileSize,
			tileSize,
			tx * tileSize - left,
			ty * tileSize - top,
		);
	}
	if (isEmpty(canvas)) return null;
	return sharp(canvas, {
		raw: { width: LEGACY_TILE_SIZE, height: LEGACY_TILE_SIZE, channels: 4 },
	})
		.flatten({ background: "#000000" })
		.png()
		.toBuffer();
}

/**
 * The tile URLs of the v1 map, `/map/<dim>/<zoom>/<x>_<z>.png`, so maps and tools built for it
 * keep working. Like v1: tiles are 512 pixels, x and z are the block coordinates of the tile's
 * top-left corner, the image is an opaque PNG with unexplored areas black, and anything without
 * a tile is a 404.
 */
export const legacyTileRoutes = new Hono<AppEnv>().get(
	"/:dim/:zoom/:tile",
	doc({
		tag: "Tiles",
		summary: "Get a map tile (v1 URL)",
		description: [
			`The tile URL of the old (v1) map, for clients made for it. Tiles are ${LEGACY_TILE_SIZE} pixels whatever the map's \`tileSize\` is. \`tile\` is \`<x>_<z>.png\`, where x and z are the block coordinates of the tile's top-left corner: a multiple of \`${LEGACY_TILE_SIZE} * 2^zoom\`. Zoom 0 is one pixel per block.`,
			"",
			`The image is a PNG without transparency, with unexplored areas black. Always the latest map. Zoom goes up to ${LEGACY_MAX_ZOOM} like v1 (or \`MAX_ZOOM\` if higher); up to ${MAX_EXTRA_LEVELS} levels above \`MAX_ZOOM\` are made from the stored tiles on the fly.`,
			"",
			"Empty tiles, unknown dimensions and coordinates that are not a tile corner answer 404, as in v1. New clients should use *Get a map tile*.",
		].join("\n"),
		ok: { 200: "The tile image", 304: "Not modified (`If-None-Match`)" },
		fails: [404],
	}),
	async (c) => {
		const { db, env, svc } = c.var;

		const zoomParam = c.req.param("zoom");
		const name = TILE_NAME.exec(c.req.param("tile"));
		if (!/^\d{1,2}$/.test(zoomParam) || !name) return notFound(c);
		const zoom = Number(zoomParam);
		if (zoom > Math.max(env.MAX_ZOOM, LEGACY_MAX_ZOOM)) return notFound(c);
		const levels = Math.max(0, zoom - env.MAX_ZOOM);
		if (levels > MAX_EXTRA_LEVELS) return notFound(c);

		const scale = 2 ** zoom;
		const bx = Number(name[1]);
		const bz = Number(name[2]);
		if (
			!Number.isSafeInteger(bx) ||
			!Number.isSafeInteger(bz) ||
			bx % (LEGACY_TILE_SIZE * scale) !== 0 ||
			bz % (LEGACY_TILE_SIZE * scale) !== 0
		) {
			return notFound(c);
		}

		const dim = dimensionBySlug(db, c.req.param("dim"));
		if (!dim) return notFound(c);
		const map = await loadMap(db);
		const { tileSize } = map;

		// The tile's pixels at `zoom`, and the stored tiles under them, `levels` further down.
		const left = bx / scale;
		const top = bz / scale;
		const n = 2 ** levels;
		const rect = {
			minX: Math.floor((left * n) / tileSize),
			minY: Math.floor((top * n) / tileSize),
			maxX: Math.floor(((left + LEGACY_TILE_SIZE) * n - 1) / tileSize),
			maxY: Math.floor(((top + LEGACY_TILE_SIZE) * n - 1) / tileSize),
		};
		if (
			(rect.maxX - rect.minX + 1) * (rect.maxY - rect.minY + 1) >
			MAX_SOURCE_TILES
		) {
			return notFound(c);
		}
		const sources = await tileHashesIn(
			db,
			dim.id,
			zoom - levels,
			rect,
			map.headRev,
		);
		if (sources.length === 0) return notFound(c);

		// A stored tile that is exactly the v1 tile: its PNG copy is kept on disk.
		const only = sources[0] as Source;
		if (tileSize === LEGACY_TILE_SIZE && levels === 0) {
			return sendPng(c, `"${only.hash}"`, () =>
				svc.blobs.derived(only.hash, "png-black"),
			);
		}

		// The image depends only on which tiles sit where, so that names it.
		const key = createHash("sha256")
			.update(
				`${tileSize}:${zoom}:${levels}:${left}:${top}:${sources
					.map((s) => `${s.x},${s.y},${s.hash}`)
					.sort()
					.join(";")}`,
			)
			.digest("hex");
		let cache = caches.get(svc.blobs);
		if (!cache) {
			cache = new Map();
			caches.set(svc.blobs, cache);
		}
		const store = cache;
		return sendPng(c, `"${key}"`, async () => {
			const cached = store.get(key);
			if (cached) return cached;
			const png = await renderLegacy(
				svc.blobs,
				tileSize,
				levels,
				left,
				top,
				sources,
			);
			if (!png) return null;
			if (store.size >= CACHE_MAX) {
				store.delete(store.keys().next().value as string);
			}
			store.set(key, png);
			return png;
		});
	},
);

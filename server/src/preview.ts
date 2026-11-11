import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type Size,
	tileLevel,
	tileRect,
	type View,
	visibleTiles,
} from "@aomc/shared/view";
import sharp, { type OverlayOptions } from "sharp";
import { randomToken } from "./auth/tokens";
import type { Db } from "./db/client";
import type { BlobStore } from "./tiles/blobstore";
import { tileHashAt } from "./tiles/history";

const PREVIEW_W = 1200;
const PREVIEW_H = 630;
const BACKGROUND = { r: 27, g: 29, b: 34, alpha: 1 };
const MAX_TILES = 150;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 20;

export type PreviewParams = {
	dimensionId: number;
	tileSize: number;
	maxZoom: number;
	x: number;
	z: number;
	zoom: number;
	rev: number;
	/** Changes when history is rewritten; see `map_info.epoch`. */
	epoch: number;
};

/** The render queue is full. */
export class PreviewBusyError extends Error {}
/** The caller may not start another render right now. */
export class PreviewLimitError extends Error {}

/**
 * Rounds a view so that nearby requests share one picture: the zoom to half levels and the
 * centre to about 16 screen pixels, which is the most the marker moves.
 */
export function snapParams(p: PreviewParams): PreviewParams {
	const zoom = Math.round(p.zoom * 2) / 2;
	const step = 2 ** Math.max(0, Math.floor(zoom) + 4);
	return {
		...p,
		zoom,
		x: Math.round(p.x / step) * step,
		z: Math.round(p.z / step) * step,
	};
}

const SIZE: Size = { width: PREVIEW_W, height: PREVIEW_H };

/** A ring and dot marking the centre of the view. */
const MARKER_SVG = Buffer.from(
	`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
		<circle cx="32" cy="32" r="22" fill="none" stroke="#000" stroke-opacity="0.65" stroke-width="8"/>
		<circle cx="32" cy="32" r="22" fill="none" stroke="#ffd23f" stroke-width="4"/>
		<circle cx="32" cy="32" r="5" fill="#ffd23f" stroke="#000" stroke-width="2"/>
	</svg>`,
);

const clamp = (n: number, lo: number, hi: number) =>
	Math.min(Math.max(n, lo), hi);

/** Composites the tiles around a point into a 1200x630 PNG. No browser involved. */
async function renderPreview(
	db: Db,
	blobs: BlobStore,
	p: PreviewParams,
): Promise<Buffer> {
	const T = p.tileSize;
	const view: View = { centerX: p.x + 0.5, centerZ: p.z + 0.5, zoom: p.zoom };

	// Very small tiles (or a wide view) can mean thousands of tiles; use a coarser level instead.
	let level = tileLevel(p.zoom, 1, p.maxZoom);
	let range = visibleTiles(view, SIZE, level, T);
	const count = () =>
		(range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
	while (count() > MAX_TILES && level < p.maxZoom) {
		level++;
		range = visibleTiles(view, SIZE, level, T);
	}

	const layers: OverlayOptions[] = [];
	for (let ty = range.minY; ty <= range.maxY; ty++) {
		for (let tx = range.minX; tx <= range.maxX; tx++) {
			const hash = await tileHashAt(db, p.dimensionId, level, tx, ty, p.rev);
			if (!hash) continue;

			const r = tileRect(view, SIZE, level, T, tx, ty);
			const dx0 = Math.max(0, Math.round(r.x));
			const dy0 = Math.max(0, Math.round(r.y));
			const dx1 = Math.min(PREVIEW_W, Math.round(r.x + r.w));
			const dy1 = Math.min(PREVIEW_H, Math.round(r.y + r.h));
			if (dx1 <= dx0 || dy1 <= dy0) continue;

			// Only decode and scale the part of the tile that is actually on screen.
			const sx0 = clamp(Math.floor(((dx0 - r.x) / r.w) * T), 0, T - 1);
			const sy0 = clamp(Math.floor(((dy0 - r.y) / r.h) * T), 0, T - 1);
			const sx1 = clamp(Math.ceil(((dx1 - r.x) / r.w) * T), sx0 + 1, T);
			const sy1 = clamp(Math.ceil(((dy1 - r.y) / r.h) * T), sy0 + 1, T);
			const { data, info } = await sharp(await blobs.read(hash))
				.ensureAlpha()
				.extract({ left: sx0, top: sy0, width: sx1 - sx0, height: sy1 - sy0 })
				.resize(dx1 - dx0, dy1 - dy0, {
					fit: "fill",
					// Magnified pixel art stays crisp; reduced tiles are filtered.
					kernel: r.w > T ? "nearest" : "lanczos3",
				})
				.raw()
				.toBuffer({ resolveWithObject: true });
			layers.push({
				input: data,
				raw: { width: info.width, height: info.height, channels: 4 },
				left: dx0,
				top: dy0,
			});
		}
	}
	layers.push({
		input: MARKER_SVG,
		left: PREVIEW_W / 2 - 32,
		top: PREVIEW_H / 2 - 32,
	});

	return sharp({
		create: {
			width: PREVIEW_W,
			height: PREVIEW_H,
			channels: 4,
			background: BACKGROUND,
		},
	})
		.composite(layers)
		.png({ compressionLevel: 6 })
		.toBuffer();
}

function previewCacheKey(p: PreviewParams): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				p.dimensionId,
				p.tileSize,
				p.x,
				p.z,
				p.zoom,
				p.rev,
				p.epoch,
			]),
		)
		.digest("hex");
}

/** Deletes the oldest cached previews beyond `max`. */
export async function pruneCache(dir: string, max: number) {
	const names = (await readdir(dir)).filter((n) => n.endsWith(".png"));
	if (names.length <= max) return;
	const withTimes = await Promise.all(
		names.map(async (name) => ({
			name,
			mtime: (await stat(join(dir, name))).mtimeMs,
		})),
	);
	withTimes.sort((a, b) => a.mtime - b.mtime);
	for (const { name } of withTimes.slice(0, names.length - max)) {
		await rm(join(dir, name), { force: true });
	}
}

/**
 * Disk cache plus: identical concurrent requests share one render, and renders run two at a
 * time, with a bounded queue (`PreviewBusyError` when it is full).
 */
export function createPreviewService(opts: {
	cacheDir: string;
	maxCached: number;
}) {
	const inFlight = new Map<string, Promise<Buffer>>();
	const waiting: (() => void)[] = [];
	let running = 0;
	let writes = 0;

	async function slot<T>(fn: () => Promise<T>): Promise<T> {
		if (running >= MAX_CONCURRENT) {
			if (waiting.length >= MAX_WAITING) throw new PreviewBusyError();
			await new Promise<void>((resolve) => waiting.push(resolve));
		} else running++;
		try {
			return await fn();
		} finally {
			// Hand the slot straight to the next waiter so a newcomer cannot jump in.
			const next = waiting.shift();
			if (next) next();
			else running--;
		}
	}

	return {
		/** `admit` is asked before a render is started; false answers with `PreviewLimitError`. */
		async get(
			db: Db,
			blobs: BlobStore,
			params: PreviewParams,
			admit: () => boolean = () => true,
		): Promise<Buffer> {
			const p = snapParams(params);
			const key = previewCacheKey(p);
			const file = join(opts.cacheDir, `${key}.png`);
			const cached = Bun.file(file);
			if (await cached.exists()) return Buffer.from(await cached.arrayBuffer());

			let job = inFlight.get(key);
			if (!job) {
				if (!admit()) throw new PreviewLimitError();
				job = slot(async () => {
					const png = await renderPreview(db, blobs, p);
					await mkdir(opts.cacheDir, { recursive: true });
					const tmp = `${file}.${randomToken(6)}.tmp`;
					await Bun.write(tmp, png);
					await rename(tmp, file);
					if (++writes % 25 === 0)
						await pruneCache(opts.cacheDir, opts.maxCached).catch(() => {});
					return png;
				}).finally(() => inFlight.delete(key));
				inFlight.set(key, job);
			}
			return job;
		},
	};
}

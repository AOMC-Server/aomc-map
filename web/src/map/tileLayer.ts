import { floorDiv } from "@aomc/shared/coords";
import type { PreloadRing } from "@aomc/shared/schemas";
import {
	type Size,
	tileLevel,
	tileRect,
	type View,
	visibleTiles,
} from "@aomc/shared/view";

export type TileSource = (zoom: number, x: number, y: number) => string;

export type TileRect = {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
};

/**
 * Looks up the image URLs of many tiles at once, keyed by `x/y`. Tiles in `rect` that are
 * missing from the result are empty. Equal URLs mean equal images.
 */
export type TileLookup = (
	zoom: number,
	rect: TileRect,
	signal: AbortSignal,
) => Promise<Map<string, string>>;

/**
 * One slot per tile coordinate. `bitmap` is the last image we know for it: undefined = nothing
 * yet, null = known to be empty. `version` says which source it came from, so when the source
 * changes (a different revision) the old image stays on screen and is replaced in place once the
 * new one has loaded. `url` is where the bitmap came from.
 */
type Entry = {
	bitmap: ImageBitmap | null | undefined;
	version: number;
	url?: string | null;
	loading?: { version: number; abort: AbortController };
	failed?: { version: number; at: number; attempts: number };
	/** A load that finished while paused, swapped in on resume. */
	held?: { bitmap: ImageBitmap | null; url: string; version: number };
};

type Wanted = {
	zoom: number;
	x: number;
	y: number;
	priority: number;
	preload?: boolean;
};

export type PreloadProgress = { done: number; failed: number; total: number };

/** Most tiles kept loaded around the origin, well within the cache. */
export const MAX_PRELOAD_TILES = 256;
/** The share of the cache budget the preloaded tiles may take; they are never evicted. */
const PRELOAD_CACHE_SHARE = 0.4;

const MIB = 1024 * 1024;

/**
 * Decoded bytes of tile images to keep, which is what costs memory (a 512 px tile is 1 MiB once
 * decoded, whatever its file size). Less on phones and low-memory devices, where the browser
 * kills the tab instead of evicting.
 */
export function cacheBudget(
	deviceMemoryGb: number | undefined,
	shortestScreenSide: number | undefined,
): number {
	const lowMemory = deviceMemoryGb !== undefined && deviceMemoryGb <= 4;
	const small = shortestScreenSide !== undefined && shortestScreenSide <= 600;
	return (lowMemory || small ? 80 : 160) * MIB;
}

function defaultCacheBudget(): number {
	const memory =
		typeof navigator === "undefined"
			? undefined
			: (navigator as { deviceMemory?: number }).deviceMemory;
	const side =
		typeof screen === "undefined"
			? undefined
			: Math.min(screen.width, screen.height);
	return cacheBudget(memory, side);
}

const bitmapBytes = (b: ImageBitmap | null | undefined) =>
	b ? b.width * b.height * 4 : 0;
const entryBytes = (e: Entry) =>
	bitmapBytes(e.bitmap) + bitmapBytes(e.held?.bitmap);

/**
 * The tiles of each ring's level within its radius of the origin, in loading order: coarsest ring
 * first (each of its tiles covers the most ground), nearest the origin first. Stops at
 * `limit` (at most MAX_PRELOAD_TILES); levels the map does not have are skipped.
 */
export function preloadTiles(
	rings: PreloadRing[],
	tileSize: number,
	maxZoom: number,
	limit = MAX_PRELOAD_TILES,
): Wanted[] {
	const tiles: Wanted[] = [];
	const seen = new Set<string>();
	const sorted = rings
		.filter((r) => r.level >= 0 && r.level <= maxZoom)
		.sort((a, b) => b.level - a.level);
	sorted.forEach(({ level, radius }, rank) => {
		const span = tileSize * 2 ** level;
		const min = floorDiv(-radius, span);
		const max = floorDiv(radius - 1, span);
		const ring: Wanted[] = [];
		for (let y = min; y <= max; y++) {
			for (let x = min; x <= max; x++) {
				const k = key(level, x, y);
				if (seen.has(k)) continue;
				seen.add(k);
				ring.push({
					zoom: level,
					x,
					y,
					priority: 2e6 + rank * 1e4 + Math.hypot(x + 0.5, y + 0.5),
				});
				if (ring.length > limit) break;
			}
			if (ring.length > limit) break;
		}
		ring.sort((a, b) => a.priority - b.priority);
		tiles.push(...ring);
	});
	return tiles.slice(0, limit);
}
type Dest = { x0: number; y0: number; x1: number; y1: number };

/**
 * What was drawn for a tile: its own current image (loaded), its own image from an older source
 * (stale), nothing because it is empty, a stand-in from a coarser (ancestor) or finer (children)
 * level, or nothing at all yet (missing).
 */
export type TileDrawState =
	| "loaded"
	| "stale"
	| "empty"
	| "ancestor"
	| "children"
	| "missing";

/**
 * Where a preloaded tile is: shown (ready), shown but of an older source (stale), known to be
 * empty, being fetched (loading), waiting for its lookup, waiting for a free request (queued),
 * or failed (retried after a delay that grows with each failure).
 */
export type PreloadTileState =
	| "ready"
	| "stale"
	| "empty"
	| "loading"
	| "lookup"
	| "queued"
	| "failed";

export type PreloadDebugInfo = {
	/** One per level, coarsest first; radius is the furthest ring of that level. */
	levels: {
		level: number;
		radius: number;
		counts: Record<PreloadTileState, number>;
		total: number;
	}[];
	tiles: {
		level: number;
		x: number;
		y: number;
		dest: Dest;
		state: PreloadTileState;
	}[];
};

/** The tiles of the last frame, for the debug view. Rectangles are in device pixels. */
export type TileDebugInfo = {
	level: number;
	tiles: {
		x: number;
		y: number;
		dest: Dest;
		state: TileDrawState;
		loading: boolean;
		lookingUp: boolean;
	}[];
	cached: number;
	preload: PreloadDebugInfo;
	inFlight: number;
	lookingUp: number;
	paused: boolean;
};

const RETRY_MS = 5000;
const MAX_RETRY_MS = 60_000;
const MAX_TILES_PER_FRAME = 600;
/** Cache entries, however small; known-empty tiles cost almost nothing but are not free. */
const MAX_CACHE_ENTRIES = 4096;
const MAX_CONCURRENT = 8;
/** Most tiles in one lookup request (the server allows more). */
const MAX_LOOKUP_AREA = 1024;
const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_URLS = 8192;

/** How long to wait before retrying a tile that has failed `attempts` times in a row. */
export const retryDelay = (attempts: number) =>
	Math.min(RETRY_MS * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_MS);

const key = (zoom: number, x: number, y: number) => `${zoom}/${x}/${y}`;

/** A tile's screen rectangle (css px) in device pixels, rounded to whole pixels. */
const deviceRect = (
	r: { x: number; y: number; w: number; h: number },
	dpr: number,
): Dest => ({
	x0: Math.round(r.x * dpr),
	y0: Math.round(r.y * dpr),
	x1: Math.round((r.x + r.w) * dpr),
	y1: Math.round((r.y + r.h) * dpr),
});

/**
 * Draws tiles from a URL template, with an LRU bitmap cache. While a tile loads, a coarser
 * ancestor (or finer children) is drawn in its place. Requests for tiles that scrolled out of
 * view are cancelled.
 *
 * With a lookup, the image URLs of all wanted tiles are fetched in one request per zoom level
 * first: empty tiles then need no request at all, and a tile whose URL did not change between
 * sources keeps its image without loading it again.
 */
export class TileLayer {
	private cache = new Map<string, Entry>();
	private source: TileSource | null = null;
	private lookup: TileLookup | null = null;
	private sourceId = 0;
	private wanted = new Map<string, Wanted>();
	private inFlight = 0;
	/** Image URLs found by the lookup for the current source; null = empty. */
	private urls = new Map<string, string | null>();
	/** Tiles whose lookup is under way. */
	private lookingUp = new Set<string>();
	private lookupAbort = new AbortController();
	/** Lookups under way per zoom level (and preload or not); only one group at a time. */
	private lookupBusy = new Map<string, number>();
	/** Record what each tile drew, for the debug view (`debugInfo`). */
	collectDebug = false;
	debugInfo: TileDebugInfo | null = null;
	/**
	 * Debugging: while paused nothing new is requested, loads that finish are held back, and only
	 * the cache entries the last frame before pausing used are drawn (`frozen`).
	 */
	private paused = false;
	private frozen: Set<string> | null = null;
	/** Cache entries the last unpaused frame drew from. */
	private used = new Set<string>();
	/** Coarse tiles around the origin that are always wanted and never evicted. */
	private preload = new Map<string, Wanted>();
	/** Furthest radius per preloaded level, for the debug view. */
	private preloadRadius = new Map<number, number>();
	private lastProgress: PreloadProgress | null = null;
	private maxBytes: number;
	/** Decoded bytes the last frame's visible tiles need; the cache never shrinks below twice that. */
	private visibleBytes = 0;

	constructor(
		private opts: {
			tileSize: number;
			maxZoom: number;
			onChange: () => void;
			preload?: PreloadRing[];
			/** Called when the share of preloaded tiles that are available changes. */
			onPreloadProgress?: (progress: PreloadProgress) => void;
			/** Decoded bytes of images to keep cached; defaults to what the device suits. */
			maxCacheBytes?: number;
		},
	) {
		this.maxBytes = opts.maxCacheBytes ?? defaultCacheBudget();
		this.setPreload(opts.preload ?? []);
	}

	/** Replaces the tiles kept loaded around the origin. Tiles already loaded are kept. */
	setPreload(rings: PreloadRing[]) {
		const tileBytes = this.opts.tileSize ** 2 * 4;
		const limit = Math.min(
			MAX_PRELOAD_TILES,
			Math.floor((this.maxBytes * PRELOAD_CACHE_SHARE) / tileBytes),
		);
		this.preload = new Map(
			preloadTiles(rings, this.opts.tileSize, this.opts.maxZoom, limit).map(
				(t) => [key(t.zoom, t.x, t.y), { ...t, preload: true }],
			),
		);
		this.preloadRadius.clear();
		for (const { level, radius } of rings) {
			if (level > this.opts.maxZoom) continue;
			this.preloadRadius.set(
				level,
				Math.max(radius, this.preloadRadius.get(level) ?? 0),
			);
		}
		this.opts.onChange();
	}

	private preloadState(k: string): PreloadTileState {
		const entry = this.cache.get(k);
		if (entry?.loading) return "loading";
		if (entry && entry.bitmap !== undefined) {
			if (!this.fresh(entry)) return "stale";
			return entry.bitmap ? "ready" : "empty";
		}
		if (entry?.failed) return "failed";
		if (this.lookingUp.has(k)) return "lookup";
		return "queued";
	}

	private preloadDebug(view: View, size: Size, dpr: number): PreloadDebugInfo {
		const T = this.opts.tileSize;
		const byLevel = new Map<number, PreloadDebugInfo["levels"][number]>();
		const tiles: PreloadDebugInfo["tiles"] = [];
		for (const [k, t] of this.preload) {
			const state = this.preloadState(k);
			let level = byLevel.get(t.zoom);
			if (!level) {
				level = {
					level: t.zoom,
					radius: this.preloadRadius.get(t.zoom) ?? 0,
					counts: {
						ready: 0,
						stale: 0,
						empty: 0,
						loading: 0,
						lookup: 0,
						queued: 0,
						failed: 0,
					},
					total: 0,
				};
				byLevel.set(t.zoom, level);
			}
			level.counts[state]++;
			level.total++;
			const r = tileRect(view, size, t.zoom, T, t.x, t.y);
			const dest = deviceRect(r, dpr);
			// Only what is on screen needs drawing.
			if (
				dest.x1 <= 0 ||
				dest.y1 <= 0 ||
				dest.x0 >= size.width * dpr ||
				dest.y0 >= size.height * dpr
			)
				continue;
			tiles.push({ level: t.zoom, x: t.x, y: t.y, dest, state });
		}
		return {
			levels: [...byLevel.values()].sort((a, b) => b.level - a.level),
			tiles,
		};
	}

	/**
	 * How many preloaded tiles have something to show (an image, possibly of an older revision,
	 * or known to be empty), and how many last failed to load.
	 */
	preloadProgress(): PreloadProgress {
		let done = 0;
		let failed = 0;
		for (const k of this.preload.keys()) {
			const entry = this.cache.get(k);
			if (entry?.bitmap !== undefined) done++;
			else if (entry?.failed) failed++;
		}
		return { done, failed, total: this.preload.size };
	}

	private reportPreload() {
		const report = this.opts.onPreloadProgress;
		if (!report) return;
		const p = this.preloadProgress();
		const last = this.lastProgress;
		if (
			last &&
			last.done === p.done &&
			last.failed === p.failed &&
			last.total === p.total
		)
			return;
		this.lastProgress = p;
		report(p);
	}

	/**
	 * keepPrevious: keep showing the images of the old source until the new ones arrive (e.g. the
	 * revision changed). Pass false when the content is unrelated (another map or dimension).
	 * lookup: resolves many tiles per request; `source` is then only used if it fails.
	 */
	setSource(source: TileSource, keepPrevious = false, lookup?: TileLookup) {
		this.source = source;
		this.lookup = lookup ?? null;
		this.sourceId++;
		this.wanted.clear();
		this.lookupAbort.abort();
		this.lookupAbort = new AbortController();
		this.urls.clear();
		this.lookingUp.clear();
		this.lookupBusy.clear();
		if (!keepPrevious) this.clear();
		this.opts.onChange();
	}

	setPaused(paused: boolean) {
		if (this.paused === paused) return;
		this.paused = paused;
		this.frozen = paused ? new Set(this.used) : null;
		if (!paused) {
			for (const entry of this.cache.values()) {
				const held = entry.held;
				if (!held) continue;
				entry.held = undefined;
				entry.bitmap?.close();
				entry.bitmap = held.bitmap;
				entry.url = held.url;
				entry.version = held.version;
				entry.failed = undefined;
			}
			this.evict();
		}
		// Redraw, which also requests whatever is now missing.
		this.opts.onChange();
	}

	private clear() {
		for (const entry of this.cache.values()) {
			entry.loading?.abort.abort();
			entry.loading = undefined; // so a response that is already on its way is ignored
			entry.bitmap?.close();
			entry.held?.bitmap?.close();
		}
		this.cache.clear();
		this.inFlight = 0;
	}

	/** Entry lookup that also marks it as recently used. */
	private touch(k: string): Entry | undefined {
		const entry = this.cache.get(k);
		if (entry) {
			this.cache.delete(k);
			this.cache.set(k, entry);
		}
		return entry;
	}

	/** An entry to draw from: none while paused unless the frame before pausing used it. */
	private use(k: string): Entry | undefined {
		if (this.frozen && !this.frozen.has(k)) return undefined;
		const entry = this.touch(k);
		if (!this.paused && this.known(entry)) this.used.add(k);
		return entry;
	}

	/** An image (possibly of an older revision) or a known-empty marker is available. */
	private known(entry: Entry | undefined): entry is Entry {
		return entry !== undefined && entry.bitmap !== undefined;
	}

	private fresh(entry: Entry) {
		return entry.version === this.sourceId;
	}

	draw(ctx: CanvasRenderingContext2D, view: View, size: Size, dpr: number) {
		this.debugInfo = null;
		if (!this.paused) this.used.clear();
		if (!this.source) return;
		const { tileSize: T, maxZoom } = this.opts;
		ctx.imageSmoothingQuality = "high";
		const level = tileLevel(view.zoom, dpr, maxZoom);
		const range = visibleTiles(view, size, level, T);
		const wanted = new Map<string, Wanted>();
		const cx = (range.minX + range.maxX) / 2;
		const cy = (range.minY + range.maxY) / 2;
		const debug: TileDebugInfo["tiles"] | null = this.collectDebug ? [] : null;

		let drawn = 0;
		for (let ty = range.minY; ty <= range.maxY; ty++) {
			for (let tx = range.minX; tx <= range.maxX; tx++) {
				if (++drawn > MAX_TILES_PER_FRAME) break;
				const priority = Math.hypot(tx - cx, ty - cy);
				wanted.set(key(level, tx, ty), {
					zoom: level,
					x: tx,
					y: ty,
					priority,
				});
				const rect = tileRect(view, size, level, T, tx, ty);
				const dest = deviceRect(rect, dpr);
				const state = this.drawTile(ctx, level, tx, ty, dest);
				if (debug) {
					const k = key(level, tx, ty);
					debug.push({
						x: tx,
						y: ty,
						dest,
						state,
						loading: this.cache.get(k)?.loading !== undefined,
						lookingUp: this.lookingUp.has(k),
					});
				}

				// A coarser parent is cheap (1/4 the tiles) and gives a quick preview while zooming.
				if (level < maxZoom) {
					const px = floorDiv(tx, 2);
					const py = floorDiv(ty, 2);
					const pk = key(level + 1, px, py);
					if (!wanted.has(pk)) {
						wanted.set(pk, {
							zoom: level + 1,
							x: px,
							y: py,
							priority: 1e6 + priority,
						});
					}
				}
			}
		}
		// Lowest priority: only loaded when nothing on screen is waiting.
		for (const [k, tile] of this.preload) {
			if (!wanted.has(k)) wanted.set(k, tile);
		}
		this.wanted = wanted;
		this.visibleBytes = Math.min(drawn, MAX_TILES_PER_FRAME) * T * T * 4;
		if (!this.paused) this.pump();
		this.reportPreload();
		if (debug) {
			this.debugInfo = {
				level,
				tiles: debug,
				cached: this.cache.size,
				preload: this.preloadDebug(view, size, dpr),
				inFlight: this.inFlight,
				lookingUp: this.lookingUp.size,
				paused: this.paused,
			};
		}
	}

	private drawTile(
		ctx: CanvasRenderingContext2D,
		level: number,
		tx: number,
		ty: number,
		d: Dest,
	): TileDrawState {
		const T = this.opts.tileSize;
		const dw = d.x1 - d.x0;
		const dh = d.y1 - d.y0;
		const exact = this.use(key(level, tx, ty));

		if (this.known(exact)) {
			if (exact.bitmap) {
				ctx.imageSmoothingEnabled = dw <= T;
				ctx.drawImage(exact.bitmap, d.x0, d.y0, dw, dh);
				return this.fresh(exact) ? "loaded" : "stale";
			}
			// Known empty. If that is out of date, a fresher coarse tile may already show content.
			if (this.fresh(exact)) return "empty";
		}

		// Ancestors: draw the sub-rectangle of a coarser tile that covers this one.
		for (let up = 1; level + up <= this.opts.maxZoom && up <= 4; up++) {
			const n = 2 ** up;
			const ax = floorDiv(tx, n);
			const ay = floorDiv(ty, n);
			const entry = this.use(key(level + up, ax, ay));
			if (!this.known(entry)) continue;
			if (!entry.bitmap) {
				if (this.fresh(entry)) return "empty";
				continue;
			}
			const sw = T / n;
			ctx.imageSmoothingEnabled = dw <= sw;
			ctx.drawImage(
				entry.bitmap,
				(tx - ax * n) * sw,
				(ty - ay * n) * sw,
				sw,
				sw,
				d.x0,
				d.y0,
				dw,
				dh,
			);
			return "ancestor";
		}

		// Children: finer tiles that are already loaded (e.g. just zoomed out).
		let state: TileDrawState = "missing";
		if (level > 0) {
			for (let j = 0; j < 2; j++) {
				for (let i = 0; i < 2; i++) {
					const child = this.use(key(level - 1, tx * 2 + i, ty * 2 + j));
					if (!this.known(child) || !child.bitmap) continue;
					const hx0 = d.x0 + Math.round((dw * i) / 2);
					const hx1 = d.x0 + Math.round((dw * (i + 1)) / 2);
					const hy0 = d.y0 + Math.round((dh * j) / 2);
					const hy1 = d.y0 + Math.round((dh * (j + 1)) / 2);
					ctx.imageSmoothingEnabled = hx1 - hx0 <= T;
					ctx.drawImage(child.bitmap, hx0, hy0, hx1 - hx0, hy1 - hy0);
					state = "children";
				}
			}
		}
		// An out-of-date empty tile with nothing better available: leave blank.
		return state;
	}

	private pump() {
		const now = Date.now();

		// Cancel requests that are no longer wanted or are for an older source.
		for (const [k, entry] of this.cache) {
			const loading = entry.loading;
			if (!loading) continue;
			if (loading.version !== this.sourceId || !this.wanted.has(k)) {
				loading.abort.abort();
				entry.loading = undefined;
				this.inFlight--;
				if (entry.bitmap === undefined) this.cache.delete(k);
			}
		}

		const pending: [string, Wanted][] = [];
		for (const [k, tile] of this.wanted) {
			const entry = this.cache.get(k);
			if (!entry) {
				pending.push([k, tile]);
				continue;
			}
			if (entry.loading) continue;
			if (this.known(entry) && this.fresh(entry)) continue;
			const failed = entry.failed;
			if (
				failed &&
				failed.version === this.sourceId &&
				now - failed.at < retryDelay(failed.attempts)
			) {
				continue;
			}
			pending.push([k, tile]);
		}
		pending.sort((a, b) => a[1].priority - b[1].priority);

		if (this.lookup) {
			this.resolve(
				pending.filter(([k]) => !this.urls.has(k) && !this.lookingUp.has(k)),
			);
		}

		let settled = false;
		for (const [k, tile] of pending) {
			let url: string | null;
			if (this.lookup) {
				const found = this.urls.get(k);
				if (found === undefined) continue; // still looking it up
				url = found;
			} else {
				if (!this.source) return;
				url = this.source(tile.zoom, tile.x, tile.y);
			}

			// Known empty, or the same image as before: nothing to load.
			const entry = this.cache.get(k);
			if (url === null || (entry?.bitmap !== undefined && entry.url === url)) {
				this.settle(k, url);
				settled = true;
				continue;
			}
			if (this.inFlight < MAX_CONCURRENT) this.start(k, url);
		}
		if (settled) this.opts.onChange();
	}

	/** Marks a tile as current without loading: empty (url null) or unchanged. */
	private settle(k: string, url: string | null) {
		let entry = this.cache.get(k);
		if (!entry) {
			entry = { bitmap: undefined, version: -1 };
			this.cache.set(k, entry);
			this.evict();
		}
		if (url === null && entry.bitmap) {
			entry.bitmap.close();
			entry.bitmap = null;
		}
		entry.bitmap ??= null;
		entry.url = url;
		entry.version = this.sourceId;
		entry.failed = undefined;
	}

	/**
	 * Looks up the given tiles, one request per zoom level (split if the area is large).
	 * Preloaded tiles get their own requests, so a view far from the origin does not stretch the
	 * rectangle all the way back to it.
	 */
	private resolve(tiles: [string, Wanted][]) {
		const groups = new Map<string, Wanted[]>();
		for (const [k, tile] of tiles) {
			const group = `${tile.zoom}:${tile.preload === true}`;
			// The next lookup of a level waits for the one under way, so a pan or zoom does not
			// pile up requests for areas that are already out of view.
			if (this.lookupBusy.has(group)) continue;
			this.lookingUp.add(k);
			const list = groups.get(group);
			if (list) list.push(tile);
			else groups.set(group, [tile]);
		}
		for (const [group, list] of groups) {
			const zoom = (list[0] as Wanted).zoom;
			const minX = Math.min(...list.map((t) => t.x));
			const maxX = Math.max(...list.map((t) => t.x));
			const minY = Math.min(...list.map((t) => t.y));
			const maxY = Math.max(...list.map((t) => t.y));
			const rows = Math.max(1, Math.floor(MAX_LOOKUP_AREA / (maxX - minX + 1)));
			for (let y = minY; y <= maxY; y += rows) {
				this.lookupRect(group, zoom, {
					minX,
					maxX,
					minY: y,
					maxY: Math.min(maxY, y + rows - 1),
				});
			}
		}
	}

	private lookupRect(group: string, zoom: number, rect: TileRect) {
		const lookup = this.lookup;
		const source = this.source;
		if (!lookup || !source) return;
		const version = this.sourceId;
		const parent = this.lookupAbort.signal;
		const stale = () => parent.aborted || version !== this.sourceId;
		const finish = (urlOf: (x: number, y: number) => string | null) => {
			if (stale()) return;
			if (this.urls.size > MAX_URLS) {
				// Keep what the tiles being waited for resolved to.
				for (const k of this.urls.keys()) {
					if (!this.wanted.has(k)) this.urls.delete(k);
				}
			}
			for (let y = rect.minY; y <= rect.maxY; y++) {
				for (let x = rect.minX; x <= rect.maxX; x++) {
					const k = key(zoom, x, y);
					this.urls.set(k, urlOf(x, y));
					this.lookingUp.delete(k);
				}
			}
		};

		this.lookupBusy.set(group, (this.lookupBusy.get(group) ?? 0) + 1);
		const own = new AbortController();
		const abort = () => own.abort();
		parent.addEventListener("abort", abort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				own.abort();
				reject(new Error("tile lookup timed out"));
			}, LOOKUP_TIMEOUT_MS);
		});
		Promise.race([lookup(zoom, rect, own.signal), timeout])
			.then((found) => finish((x, y) => found.get(`${x}/${y}`) ?? null))
			.catch((err) => {
				if (stale()) return;
				console.warn("tile lookup failed", zoom, rect, err);
				// Fall back to loading these tiles one by one.
				finish((x, y) => source(zoom, x, y));
			})
			.finally(() => {
				clearTimeout(timer);
				parent.removeEventListener("abort", abort);
				if (version !== this.sourceId) return;
				const left = (this.lookupBusy.get(group) ?? 1) - 1;
				if (left > 0) this.lookupBusy.set(group, left);
				else this.lookupBusy.delete(group);
				// Tiles that waited for this lookup can go next.
				this.opts.onChange();
			});
	}

	private start(k: string, url: string) {
		const version = this.sourceId;
		const abort = new AbortController();
		const loading = { version, abort };

		let entry = this.cache.get(k);
		if (!entry) {
			entry = { bitmap: undefined, version: -1 };
			this.cache.set(k, entry);
		}
		const target = entry;
		target.loading = loading;
		this.inFlight++;
		this.evict();

		fetch(url, { signal: abort.signal })
			.then(async (res) => {
				if (res.status === 204) return null;
				if (!res.ok) throw new Error(`tile ${res.status}`);
				return createImageBitmap(await res.blob());
			})
			.then((bitmap) => {
				if (target.loading !== loading) {
					bitmap?.close();
					return;
				}
				target.loading = undefined;
				this.inFlight--;
				if (this.paused) {
					target.held = { bitmap, url, version };
					return;
				}
				// Swap in place: the old image stays visible right up to this moment.
				target.bitmap?.close();
				target.bitmap = bitmap;
				target.url = url;
				target.version = version;
				target.failed = undefined;
				this.evict();
				this.opts.onChange();
			})
			.catch((err) => {
				if (abort.signal.aborted || target.loading !== loading) return;
				console.warn("tile load failed", url, err);
				target.loading = undefined;
				this.inFlight--;
				const attempts =
					target.failed?.version === version ? target.failed.attempts + 1 : 1;
				target.failed = { version, at: Date.now(), attempts };
				// The freed slot can go to another tile now; this one comes back after its delay.
				this.opts.onChange();
				setTimeout(() => this.opts.onChange(), retryDelay(attempts) + 50);
			});
	}

	/** Drops the least recently used images until the cache is within its budget. */
	private evict() {
		const budget = Math.max(this.maxBytes, this.visibleBytes * 2);
		let bytes = 0;
		for (const entry of this.cache.values()) bytes += entryBytes(entry);
		for (const [k, entry] of this.cache) {
			if (bytes <= budget && this.cache.size <= MAX_CACHE_ENTRIES) break;
			if (entry.loading || this.preload.has(k)) continue;
			bytes -= entryBytes(entry);
			entry.bitmap?.close();
			entry.held?.bitmap?.close();
			this.cache.delete(k);
		}
	}
}

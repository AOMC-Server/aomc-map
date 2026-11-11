import { floorDiv } from "@aomc/shared/coords";
import {
	type Size,
	tileLevel,
	tileRect,
	type View,
	visibleTiles,
} from "@aomc/shared/view";

export type TileSource = (zoom: number, x: number, y: number) => string;

/**
 * One slot per tile coordinate. `bitmap` is the last image we know for it: undefined = nothing
 * yet, null = known to be empty. `version` says which source it came from, so when the source
 * changes (a different revision) the old image stays on screen and is replaced in place once the
 * new one has loaded.
 */
type Entry = {
	bitmap: ImageBitmap | null | undefined;
	version: number;
	loading?: { version: number; abort: AbortController };
	failed?: { version: number; at: number };
};

type Wanted = { zoom: number; x: number; y: number; priority: number };
type Dest = { x0: number; y0: number; x1: number; y1: number };

const RETRY_MS = 5000;
const MAX_TILES_PER_FRAME = 600;
const MAX_CACHE = 512;
const MAX_CONCURRENT = 8;

const key = (zoom: number, x: number, y: number) => `${zoom}/${x}/${y}`;

/**
 * Draws tiles from a URL template, with an LRU bitmap cache. While a tile loads, a coarser
 * ancestor (or finer children) is drawn in its place. Requests for tiles that scrolled out of
 * view are cancelled.
 */
export class TileLayer {
	private cache = new Map<string, Entry>();
	private source: TileSource | null = null;
	private sourceId = 0;
	private wanted = new Map<string, Wanted>();
	private inFlight = 0;

	constructor(
		private opts: {
			tileSize: number;
			maxZoom: number;
			onChange: () => void;
		},
	) {}

	/**
	 * keepPrevious: keep showing the images of the old source until the new ones arrive (e.g. the
	 * revision changed). Pass false when the content is unrelated (another map or dimension).
	 */
	setSource(source: TileSource, keepPrevious = false) {
		this.source = source;
		this.sourceId++;
		this.wanted.clear();
		if (!keepPrevious) this.clear();
		this.opts.onChange();
	}

	private clear() {
		for (const entry of this.cache.values()) {
			entry.loading?.abort.abort();
			entry.loading = undefined; // so a response that is already on its way is ignored
			entry.bitmap?.close();
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

	/** An image (possibly of an older revision) or a known-empty marker is available. */
	private known(entry: Entry | undefined): entry is Entry {
		return entry !== undefined && entry.bitmap !== undefined;
	}

	private fresh(entry: Entry) {
		return entry.version === this.sourceId;
	}

	draw(ctx: CanvasRenderingContext2D, view: View, size: Size, dpr: number) {
		if (!this.source) return;
		const { tileSize: T, maxZoom } = this.opts;
		ctx.imageSmoothingQuality = "high";
		const level = tileLevel(view.zoom, dpr, maxZoom);
		const range = visibleTiles(view, size, level, T);
		const wanted = new Map<string, Wanted>();
		const cx = (range.minX + range.maxX) / 2;
		const cy = (range.minY + range.maxY) / 2;

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
				this.drawTile(ctx, level, tx, ty, {
					x0: Math.round(rect.x * dpr),
					y0: Math.round(rect.y * dpr),
					x1: Math.round((rect.x + rect.w) * dpr),
					y1: Math.round((rect.y + rect.h) * dpr),
				});

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
		this.wanted = wanted;
		this.pump();
	}

	private drawTile(
		ctx: CanvasRenderingContext2D,
		level: number,
		tx: number,
		ty: number,
		d: Dest,
	) {
		const T = this.opts.tileSize;
		const dw = d.x1 - d.x0;
		const dh = d.y1 - d.y0;
		const exact = this.touch(key(level, tx, ty));

		if (this.known(exact)) {
			if (exact.bitmap) {
				ctx.imageSmoothingEnabled = dw <= T;
				ctx.drawImage(exact.bitmap, d.x0, d.y0, dw, dh);
				return;
			}
			// Known empty. If that is out of date, a fresher coarse tile may already show content.
			if (this.fresh(exact)) return;
		}

		// Ancestors: draw the sub-rectangle of a coarser tile that covers this one.
		for (let up = 1; level + up <= this.opts.maxZoom && up <= 4; up++) {
			const n = 2 ** up;
			const ax = floorDiv(tx, n);
			const ay = floorDiv(ty, n);
			const entry = this.touch(key(level + up, ax, ay));
			if (!this.known(entry)) continue;
			if (!entry.bitmap) {
				if (this.fresh(entry)) return;
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
			return;
		}

		// Children: finer tiles that are already loaded (e.g. just zoomed out).
		if (level > 0) {
			for (let j = 0; j < 2; j++) {
				for (let i = 0; i < 2; i++) {
					const child = this.touch(key(level - 1, tx * 2 + i, ty * 2 + j));
					if (!this.known(child) || !child.bitmap) continue;
					const hx0 = d.x0 + Math.round((dw * i) / 2);
					const hx1 = d.x0 + Math.round((dw * (i + 1)) / 2);
					const hy0 = d.y0 + Math.round((dh * j) / 2);
					const hy1 = d.y0 + Math.round((dh * (j + 1)) / 2);
					ctx.imageSmoothingEnabled = hx1 - hx0 <= T;
					ctx.drawImage(child.bitmap, hx0, hy0, hx1 - hx0, hy1 - hy0);
				}
			}
		}
		// An out-of-date empty tile with nothing better available: leave blank.
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
				now - failed.at < RETRY_MS
			) {
				continue;
			}
			pending.push([k, tile]);
		}
		pending.sort((a, b) => a[1].priority - b[1].priority);

		for (const [k, tile] of pending) {
			if (this.inFlight >= MAX_CONCURRENT) break;
			this.start(k, tile);
		}
	}

	private start(k: string, tile: Wanted) {
		if (!this.source) return;
		const version = this.sourceId;
		const url = this.source(tile.zoom, tile.x, tile.y);
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
				// Swap in place: the old image stays visible right up to this moment.
				target.bitmap?.close();
				target.bitmap = bitmap;
				target.version = version;
				target.failed = undefined;
				this.opts.onChange();
			})
			.catch((err) => {
				if (abort.signal.aborted || target.loading !== loading) return;
				console.warn("tile load failed", url, err);
				target.loading = undefined;
				this.inFlight--;
				target.failed = { version, at: Date.now() };
				setTimeout(() => this.opts.onChange(), RETRY_MS + 50);
			});
	}

	private evict() {
		for (const [k, entry] of this.cache) {
			if (this.cache.size <= MAX_CACHE) break;
			if (entry.loading) continue;
			entry.bitmap?.close();
			this.cache.delete(k);
		}
	}
}

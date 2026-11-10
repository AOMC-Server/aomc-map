import { floorDiv } from "@aomc/shared/coords";
import {
	type Size,
	tileLevel,
	tileRect,
	type View,
	visibleTiles,
} from "./camera";

export type TileSource = (zoom: number, x: number, y: number) => string;

type Entry = {
	state: "loading" | "loaded" | "empty" | "error";
	bitmap?: ImageBitmap;
	abort?: AbortController;
	failedAt?: number;
};

type Wanted = { zoom: number; x: number; y: number; priority: number };

const RETRY_MS = 5000;
const MAX_TILES_PER_FRAME = 600;

/**
 * Draws tiles from a URL template, with an LRU bitmap cache. While a tile loads, a coarser
 * ancestor (or finer children) is drawn in its place. Requests for tiles that scrolled out of
 * view are cancelled.
 */
export class TileLayer {
	private cache = new Map<string, Entry>();
	private source: TileSource | null = null;
	private sourceId = 0;
	private previousId: number | null = null;
	private queue: Map<string, Wanted> = new Map();
	private inFlight = 0;

	constructor(
		private opts: {
			tileSize: number;
			maxZoom: number;
			onChange: () => void;
			maxCache?: number;
			maxConcurrent?: number;
		},
	) {}

	/** keepPrevious: keep showing the old source's tiles until the new ones arrive (e.g. head moved). */
	setSource(source: TileSource | null, keepPrevious = false) {
		this.previousId = keepPrevious && this.source ? this.sourceId : null;
		this.source = source;
		this.sourceId++;
		this.queue.clear();
		this.opts.onChange();
	}

	private key(id: number, zoom: number, x: number, y: number) {
		return `${id}/${zoom}/${x}/${y}`;
	}

	/** Entry lookup that also marks it as recently used. */
	private touch(
		id: number,
		zoom: number,
		x: number,
		y: number,
	): Entry | undefined {
		const key = this.key(id, zoom, x, y);
		const entry = this.cache.get(key);
		if (entry) {
			this.cache.delete(key);
			this.cache.set(key, entry);
		}
		return entry;
	}

	private loaded(zoom: number, x: number, y: number): Entry | undefined {
		for (const id of [this.sourceId, this.previousId]) {
			if (id === null) continue;
			const entry = this.touch(id, zoom, x, y);
			if (
				entry &&
				(entry.state === "loaded" ||
					(id === this.sourceId && entry.state === "empty"))
			) {
				return entry;
			}
		}
		return undefined;
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
				const key = this.key(this.sourceId, level, tx, ty);
				wanted.set(key, { zoom: level, x: tx, y: ty, priority });
				const rect = tileRect(view, size, level, T, tx, ty);
				const dest = {
					x0: Math.round(rect.x * dpr),
					y0: Math.round(rect.y * dpr),
					x1: Math.round((rect.x + rect.w) * dpr),
					y1: Math.round((rect.y + rect.h) * dpr),
				};
				this.drawTile(ctx, level, tx, ty, dest);

				// A coarser parent is cheap (1/4 the tiles) and gives a quick preview while zooming.
				if (level < maxZoom) {
					const px = floorDiv(tx, 2);
					const py = floorDiv(ty, 2);
					const pk = this.key(this.sourceId, level + 1, px, py);
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
		this.queue = wanted;
		this.pump();
	}

	private drawTile(
		ctx: CanvasRenderingContext2D,
		level: number,
		tx: number,
		ty: number,
		d: { x0: number; y0: number; x1: number; y1: number },
	) {
		const T = this.opts.tileSize;
		const dw = d.x1 - d.x0;
		const dh = d.y1 - d.y0;
		const exact = this.loaded(level, tx, ty);
		if (exact?.state === "empty") return;
		if (exact?.bitmap) {
			ctx.imageSmoothingEnabled = dw <= T;
			ctx.drawImage(exact.bitmap, d.x0, d.y0, dw, dh);
			return;
		}

		// Ancestors: draw the sub-rectangle of a coarser tile that covers this one.
		for (let up = 1; level + up <= this.opts.maxZoom && up <= 4; up++) {
			const n = 2 ** up;
			const ax = floorDiv(tx, n);
			const ay = floorDiv(ty, n);
			const entry = this.loaded(level + up, ax, ay);
			if (!entry) continue;
			if (entry.state === "empty" || !entry.bitmap) return;
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
					const child = this.loaded(level - 1, tx * 2 + i, ty * 2 + j);
					if (!child?.bitmap) continue;
					const hx0 = d.x0 + Math.round((dw * i) / 2);
					const hx1 = d.x0 + Math.round((dw * (i + 1)) / 2);
					const hy0 = d.y0 + Math.round((dh * j) / 2);
					const hy1 = d.y0 + Math.round((dh * (j + 1)) / 2);
					ctx.imageSmoothingEnabled = hx1 - hx0 <= T;
					ctx.drawImage(child.bitmap, hx0, hy0, hx1 - hx0, hy1 - hy0);
				}
			}
		}
	}

	private pump() {
		const maxConcurrent = this.opts.maxConcurrent ?? 8;
		const now = Date.now();

		// Cancel in-flight requests that are no longer wanted.
		for (const [key, entry] of this.cache) {
			if (entry.state === "loading" && !this.queue.has(key)) {
				entry.abort?.abort();
				this.inFlight--;
				this.cache.delete(key);
			}
		}

		const pending = [...this.queue.entries()]
			.filter(([key]) => {
				const entry = this.cache.get(key);
				if (!entry) return true;
				if (entry.state === "error" && now - (entry.failedAt ?? 0) > RETRY_MS) {
					this.cache.delete(key);
					return true;
				}
				return false;
			})
			.sort((a, b) => a[1].priority - b[1].priority);

		for (const [key, tile] of pending) {
			if (this.inFlight >= maxConcurrent) break;
			this.start(key, tile);
		}
	}

	private start(key: string, tile: Wanted) {
		if (!this.source) return;
		const url = this.source(tile.zoom, tile.x, tile.y);
		const abort = new AbortController();
		const entry: Entry = { state: "loading", abort };
		this.cache.set(key, entry);
		this.inFlight++;
		this.evict();

		const finish = () => {
			if (this.cache.get(key) === entry) this.inFlight--;
		};
		fetch(url, { signal: abort.signal })
			.then(async (res) => {
				if (res.status === 204) return null;
				if (!res.ok) throw new Error(`tile ${res.status}`);
				return createImageBitmap(await res.blob());
			})
			.then((bitmap) => {
				if (this.cache.get(key) !== entry) {
					bitmap?.close();
					return;
				}
				finish();
				entry.abort = undefined;
				entry.state = bitmap ? "loaded" : "empty";
				entry.bitmap = bitmap ?? undefined;
				this.opts.onChange();
			})
			.catch((err) => {
				if (abort.signal.aborted || this.cache.get(key) !== entry) return;
				console.warn("tile load failed", url, err);
				finish();
				entry.abort = undefined;
				entry.state = "error";
				entry.failedAt = Date.now();
				setTimeout(() => this.opts.onChange(), RETRY_MS + 50);
			});
	}

	private evict() {
		const max = this.opts.maxCache ?? 512;
		for (const [key, entry] of this.cache) {
			if (this.cache.size <= max) break;
			if (entry.state === "loading") continue;
			entry.bitmap?.close();
			this.cache.delete(key);
		}
	}

	dispose() {
		for (const entry of this.cache.values()) {
			entry.abort?.abort();
			entry.bitmap?.close();
		}
		this.cache.clear();
	}
}

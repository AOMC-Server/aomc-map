import {
	blockToScreen,
	type Size,
	scaleOf,
	type View,
} from "@aomc/shared/view";
import { BLOCK_CENTER } from "./featureLayer";
import type {
	PreloadDebugInfo,
	PreloadTileState,
	TileDebugInfo,
	TileDrawState,
} from "./tileLayer";
import { viewportBlocks } from "./viewport";

export type DebugOptions = {
	/** Tile states, labels and a panel of renderer statistics. */
	debug: boolean;
	tileOutlines: boolean;
	chunkOutlines: boolean;
};

export const NO_DEBUG: DebugOptions = {
	debug: false,
	tileOutlines: false,
	chunkOutlines: false,
};

export const CHUNK_SIZE = 16;
/** Grid lines closer together than this (css px) are not drawn. */
const MIN_GRID_SPACING = 6;
/** Chunk outlines appear from 1:1 (one css px per block) inwards. */
const MIN_CHUNK_SCALE = 1;
/** Block outlines appear once blocks are at least this wide (css px). */
const MIN_BLOCK_GRID = 8;
/** Chunk coordinates are labelled once chunks are at least this wide (css px). */
const MIN_CHUNK_LABEL = 72;
/** Block coordinates are labelled once blocks are at least this wide (css px). */
const MIN_BLOCK_LABEL = 56;

const STATE_TINT: Record<TileDrawState, string | null> = {
	loaded: null,
	stale: "rgba(255, 200, 0, 0.25)",
	empty: "rgba(128, 128, 128, 0.2)",
	ancestor: "rgba(0, 140, 255, 0.25)",
	children: "rgba(170, 0, 255, 0.25)",
	missing: "rgba(255, 0, 0, 0.25)",
};

/** Block coordinates of the grid lines (multiples of `span`) that cross the viewport. */
export function gridLines(
	view: View,
	size: Size,
	span: number,
): { xs: number[]; zs: number[] } {
	const b = viewportBlocks(view, size);
	const range = (lo: number, hi: number) => {
		const out: number[] = [];
		// + 0 turns -0 into 0.
		for (let v = Math.ceil(lo / span) * span + 0; v <= hi; v += span)
			out.push(v);
		return out;
	};
	return {
		xs: range(b.minX, b.maxX),
		zs: range(b.minZ, b.maxZ),
	};
}

/**
 * Draws lines every `span` blocks, in device pixels so they stay one pixel sharp. Returns false
 * (drawing nothing) when they would be closer together than `minSpacing` css px.
 */
export function drawGrid(
	ctx: CanvasRenderingContext2D,
	view: View,
	size: Size,
	dpr: number,
	span: number,
	color: string,
	minSpacing = MIN_GRID_SPACING,
): boolean {
	if (span * scaleOf(view.zoom) < minSpacing) return false;
	const { xs, zs } = gridLines(view, size, span);
	const w = ctx.canvas.width;
	const h = ctx.canvas.height;
	const lw = Math.max(1, Math.round(dpr));
	const offset = lw % 2 ? 0.5 : 0;
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.strokeStyle = color;
	ctx.lineWidth = lw;
	ctx.beginPath();
	for (const x of xs) {
		const sx = Math.round(blockToScreen(view, size, x, 0).x * dpr) + offset;
		ctx.moveTo(sx, 0);
		ctx.lineTo(sx, h);
	}
	for (const z of zs) {
		const sy = Math.round(blockToScreen(view, size, 0, z).y * dpr) + offset;
		ctx.moveTo(0, sy);
		ctx.lineTo(w, sy);
	}
	ctx.stroke();
	ctx.restore();
	return true;
}

/** Multiples of `span` whose cell is at least partly in view: the grid lines plus the cell before the first. */
function cells(view: View, size: Size, span: number) {
	const { xs, zs } = gridLines(view, size, span);
	const first = (lines: number[], centre: number) =>
		(lines[0] ?? Math.floor(centre / span) * span + span) - span;
	return {
		xs: [first(xs, view.centerX), ...xs],
		zs: [first(zs, view.centerZ), ...zs],
	};
}

/**
 * The chunk grid, from 1:1 inwards. Zoomed in further it adds chunk coordinates, then the
 * block grid, and finally each block's coordinates.
 */
export function drawChunkGrid(
	ctx: CanvasRenderingContext2D,
	view: View,
	size: Size,
	dpr: number,
) {
	const s = scaleOf(view.zoom);
	if (s < MIN_CHUNK_SCALE - 1e-9) return;
	drawGrid(ctx, view, size, dpr, 1, "rgba(255,255,255,0.15)", MIN_BLOCK_GRID);
	drawGrid(ctx, view, size, dpr, CHUNK_SIZE, "rgba(255,255,255,0.45)", 0);

	ctx.save();
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.font = "11px monospace";
	ctx.textBaseline = "top";

	if (s >= MIN_BLOCK_LABEL) {
		const { xs, zs } = cells(view, size, 1);
		for (const z of zs) {
			for (const x of xs) {
				const p = blockToScreen(view, size, x + BLOCK_CENTER, z + BLOCK_CENTER);
				const lx = `x ${x}`;
				const lz = `z ${z}`;
				const w = Math.max(
					ctx.measureText(lx).width,
					ctx.measureText(lz).width,
				);
				if (w > s - 8) continue;
				// Centred, but below the chunk label in a chunk's corner block.
				const y = Math.max(p.y - 14, p.y - s / 2 + 20);
				label(ctx, lx, p.x - w / 2, y, "#fff");
				label(ctx, lz, p.x - w / 2, y + 15, "#fff");
			}
		}
	}

	if (CHUNK_SIZE * s >= MIN_CHUNK_LABEL) {
		const { xs, zs } = cells(view, size, CHUNK_SIZE);
		for (const z of zs) {
			for (const x of xs) {
				const p = blockToScreen(view, size, x, z);
				label(
					ctx,
					`chunk ${x / CHUNK_SIZE}, ${z / CHUNK_SIZE}`,
					p.x + 3,
					p.y + 3,
					"#ff0",
				);
			}
		}
	}
	ctx.restore();
}

/** Tints each tile by how it was drawn and labels it with its address and state. */
export function drawTileDebug(
	ctx: CanvasRenderingContext2D,
	info: TileDebugInfo,
	dpr: number,
) {
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	for (const t of info.tiles) {
		const tint = STATE_TINT[t.state];
		if (!tint) continue;
		ctx.fillStyle = tint;
		ctx.fillRect(
			t.dest.x0,
			t.dest.y0,
			t.dest.x1 - t.dest.x0,
			t.dest.y1 - t.dest.y0,
		);
	}
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.font = "11px monospace";
	ctx.textBaseline = "top";
	for (const t of info.tiles) {
		const w = (t.dest.x1 - t.dest.x0) / dpr;
		if (w < 90) continue;
		const x = t.dest.x0 / dpr + 4;
		const y = t.dest.y0 / dpr + 4;
		const flags = [t.lookingUp && "lookup", t.loading && "loading"]
			.filter(Boolean)
			.join(" ");
		label(ctx, `${info.level}/${t.x}/${t.y}`, x, y, "#fff");
		label(ctx, flags ? `${t.state} · ${flags}` : t.state, x, y + 15, "#ff0");
	}
	ctx.restore();
}

export const PRELOAD_COLOR: Record<PreloadTileState, string> = {
	ready: "#3c3",
	stale: "#fc0",
	empty: "#999",
	loading: "#0cf",
	lookup: "#fff",
	queued: "#f80",
	failed: "#f33",
};

/**
 * Outlines the preloaded tiles around spawn in the colour of their state, dashed so they stand
 * apart from the tile outlines. Each level is inset a little further than the next coarser one,
 * so the edges they share stay visible, and labelled from the bottom-left corner up.
 */
export function drawPreloadDebug(
	ctx: CanvasRenderingContext2D,
	info: PreloadDebugInfo,
	dpr: number,
) {
	const rank = new Map(info.levels.map((l, i) => [l.level, i]));
	const lw = Math.max(1, Math.round(dpr));
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.lineWidth = lw;
	ctx.setLineDash([6 * lw, 4 * lw]);
	for (const t of info.tiles) {
		const inset = ((rank.get(t.level) ?? 0) * 3 + 1) * lw;
		ctx.strokeStyle = PRELOAD_COLOR[t.state];
		ctx.strokeRect(
			t.dest.x0 + inset + 0.5,
			t.dest.y0 + inset + 0.5,
			t.dest.x1 - t.dest.x0 - 2 * inset,
			t.dest.y1 - t.dest.y0 - 2 * inset,
		);
	}
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.font = "11px monospace";
	ctx.textBaseline = "top";
	for (const t of info.tiles) {
		if ((t.dest.x1 - t.dest.x0) / dpr < 140) continue;
		const r = rank.get(t.level) ?? 0;
		label(
			ctx,
			`preload ${t.level}/${t.x}/${t.y} ${t.state}`,
			t.dest.x0 / dpr + 4 + r * 3,
			t.dest.y1 / dpr - 18 - r * 16,
			PRELOAD_COLOR[t.state],
		);
	}
	ctx.restore();
}

/**
 * One line per preloaded level for the debug HUD, e.g. "L3 1/8 ≤8192 10/16 done, 3 empty,
 * 2 loading": done counts every tile with something to show, the rest break it down.
 */
export function preloadHudLines(info: PreloadDebugInfo): string[] {
	if (info.levels.length === 0) return ["preload off"];
	return info.levels.map((l, i) => {
		const done = l.counts.ready + l.counts.stale + l.counts.empty;
		const rest = (Object.keys(l.counts) as PreloadTileState[])
			.filter((s) => s !== "ready" && l.counts[s] > 0)
			.map((s) => `${l.counts[s]} ${s}`);
		const res = l.level === 0 ? "1/1" : `1/${2 ** l.level}`;
		const head = `L${l.level} ${res.padEnd(5)} ≤${String(l.radius).padEnd(6)}`;
		const counts = [`${done}/${l.total} done`, ...rest].join(", ");
		return `${i === 0 ? "preload" : "       "} ${head} ${counts}`;
	});
}

/** A box of text lines in the top-left of the map (css px). */
export function drawHud(
	ctx: CanvasRenderingContext2D,
	lines: string[],
	x: number,
	y: number,
) {
	ctx.save();
	ctx.font = "12px monospace";
	ctx.textBaseline = "top";
	const lineH = 15;
	const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
	ctx.fillStyle = "rgba(0,0,0,0.65)";
	ctx.fillRect(x, y, width + 12, lines.length * lineH + 8);
	ctx.fillStyle = "#fff";
	lines.forEach((l, i) => {
		ctx.fillText(l, x + 6, y + 5 + i * lineH);
	});
	ctx.restore();
}

function label(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	color: string,
) {
	const w = ctx.measureText(text).width;
	ctx.fillStyle = "rgba(0,0,0,0.55)";
	ctx.fillRect(x - 2, y - 1, w + 4, 14);
	ctx.fillStyle = color;
	ctx.fillText(text, x, y);
}

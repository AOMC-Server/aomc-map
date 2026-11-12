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
	regionOutlines: boolean;
	/** The in-game map scales (0–4) to outline; empty for none. */
	mapScales: readonly number[];
};

export const NO_DEBUG: DebugOptions = {
	debug: false,
	tileOutlines: false,
	chunkOutlines: false,
	regionOutlines: false,
	mapScales: [],
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

/** Block coordinates of the grid lines (`origin` plus multiples of `span`) that cross the viewport. */
export function gridLines(
	view: View,
	size: Size,
	span: number,
	origin = 0,
): { xs: number[]; zs: number[] } {
	const b = viewportBlocks(view, size);
	const range = (lo: number, hi: number) => {
		const out: number[] = [];
		// + 0 turns -0 into 0.
		for (
			let v = Math.ceil((lo - origin) / span) * span + origin + 0;
			v <= hi;
			v += span
		)
			out.push(v);
		return out;
	};
	return {
		xs: range(b.minX, b.maxX),
		zs: range(b.minZ, b.maxZ),
	};
}

export type GridStyle = {
	/** Lines closer together than this (css px) are not drawn. */
	minSpacing?: number;
	/** Where the grid starts: lines are at `origin` plus multiples of the span. */
	origin?: number;
	/** Line width in css px. */
	width?: number;
	/** A dark edge on both sides of each line, so it stands out from the terrain. */
	halo?: boolean;
};

/**
 * Draws lines every `span` blocks, in device pixels so they stay sharp. Returns false (drawing
 * nothing) when they would be closer together than `minSpacing` css px.
 */
export function drawGrid(
	ctx: CanvasRenderingContext2D,
	view: View,
	size: Size,
	dpr: number,
	span: number,
	color: string,
	{
		minSpacing = MIN_GRID_SPACING,
		origin = 0,
		width = 1,
		halo = false,
	}: GridStyle = {},
): boolean {
	if (span * scaleOf(view.zoom) < minSpacing) return false;
	const { xs, zs } = gridLines(view, size, span, origin);
	const w = ctx.canvas.width;
	const h = ctx.canvas.height;
	const lw = Math.max(1, Math.round(dpr * width));
	const offset = lw % 2 ? 0.5 : 0;
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
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
	if (halo) {
		ctx.strokeStyle = "rgba(0,0,0,0.6)";
		// Even, so the line stays centred on the same pixel boundary.
		ctx.lineWidth = lw + 2 * Math.max(1, Math.round(dpr));
		ctx.stroke();
	}
	ctx.strokeStyle = color;
	ctx.lineWidth = lw;
	ctx.stroke();
	ctx.restore();
	return true;
}

/** Grid lines whose cell is at least partly in view: the grid lines plus the cell before the first. */
function cells(view: View, size: Size, span: number, origin = 0) {
	const { xs, zs } = gridLines(view, size, span, origin);
	const first = (lines: number[], centre: number) =>
		(lines[0] ?? Math.floor((centre - origin) / span) * span + origin + span) -
		span;
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
	drawGrid(ctx, view, size, dpr, 1, "rgba(255,255,255,0.15)", {
		minSpacing: MIN_BLOCK_GRID,
	});
	drawGrid(ctx, view, size, dpr, CHUNK_SIZE, "rgba(255,255,255,0.45)", {
		minSpacing: 0,
	});

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

/** Region files cover 32×32 chunks. */
export const REGION_SIZE = 512;
/** Region outlines are labelled once regions are at least this wide (css px). */
const MIN_REGION_LABEL = 90;

/** The region grid, labelled with each region's file name (r.X.Z). */
export function drawRegionGrid(
	ctx: CanvasRenderingContext2D,
	view: View,
	size: Size,
	dpr: number,
) {
	const style = { width: 2, halo: true };
	if (!drawGrid(ctx, view, size, dpr, REGION_SIZE, "#0df", style)) return;
	if (REGION_SIZE * scaleOf(view.zoom) < MIN_REGION_LABEL) return;
	ctx.save();
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.font = "11px monospace";
	ctx.textBaseline = "top";
	const { xs, zs } = cells(view, size, REGION_SIZE);
	for (const z of zs) {
		for (const x of xs) {
			const p = blockToScreen(view, size, x, z);
			// Below where a chunk label goes in the same corner.
			label(
				ctx,
				`r.${x / REGION_SIZE}.${z / REGION_SIZE}`,
				p.x + 3,
				p.y + 20,
				"#0df",
			);
		}
	}
	ctx.restore();
}

/** Blocks across an in-game map at scale 0 (1:1); each scale up doubles it. */
export const MAP_SIZE = 128;
/** In-game maps are aligned to a grid that starts half a scale 0 map from the origin. */
export const MAP_ORIGIN = -64;
export const MAX_MAP_SCALE = 4;
/** Map outlines closer together than this (css px) are not drawn. */
const MIN_MAP_SPACING = 12;
/** Maps are labelled once they are at least this wide (css px). */
const MIN_MAP_LABEL = 160;

/** The area an in-game map made at `block` with `scale` (0–4) shows, and its centre. */
export function mapArea(block: number, scale: number) {
	const span = MAP_SIZE * 2 ** scale;
	const min = Math.floor((block - MAP_ORIGIN) / span) * span + MAP_ORIGIN;
	return { min, max: min + span, centre: min + span / 2 };
}

/** A colour per map scale, from 1:1 to 1:16, far enough apart to tell nested grids apart. */
export const MAP_SCALE_COLORS = [
	"#ffe14d",
	"#ff9a1f",
	"#ff4d4d",
	"#e84dff",
	"#5dff6a",
] as const;

/**
 * The outlines of the areas in-game maps show, for the given scales from 0 (1:1, 128 blocks) to
 * 4 (1:16, 2048 blocks). A coarser scale's edges are also edges of the finer ones, so with more
 * than one each scale has its own colour and is drawn thicker, over the finer ones. Every map
 * wide enough is labelled with its scale and centre in its bottom-left corner, which the maps of
 * finer scales share: the labels stack, finest at the bottom.
 */
export function drawMapGrid(
	ctx: CanvasRenderingContext2D,
	view: View,
	size: Size,
	dpr: number,
	scales: readonly number[],
) {
	const s = scaleOf(view.zoom);
	const shown = [...scales]
		.filter((n) => n >= 0 && n <= MAX_MAP_SCALE)
		.sort((a, b) => a - b);
	if (shown.length === 0) return;
	const single = shown.length === 1;
	for (const scale of shown) {
		drawGrid(
			ctx,
			view,
			size,
			dpr,
			MAP_SIZE * 2 ** scale,
			MAP_SCALE_COLORS[scale] as string,
			{
				minSpacing: MIN_MAP_SPACING,
				origin: MAP_ORIGIN,
				width: single ? 2 : 1 + scale,
				halo: true,
			},
		);
	}

	ctx.save();
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.font = "11px monospace";
	ctx.textBaseline = "top";
	let row = 0;
	for (const scale of shown) {
		const span = MAP_SIZE * 2 ** scale;
		if (span * s < MIN_MAP_LABEL) continue;
		const { xs, zs } = cells(view, size, span, MAP_ORIGIN);
		for (const z of zs) {
			for (const x of xs) {
				// In the bottom-left corner (the top-left one is where chunk labels go), clear
				// of the thickest lines that can meet there.
				const p = blockToScreen(view, size, x, z + span);
				label(
					ctx,
					`map 1:${2 ** scale} · centre ${x + span / 2}, ${z + span / 2}`,
					p.x + 7,
					p.y - 22 - row * 16,
					MAP_SCALE_COLORS[scale] as string,
				);
			}
		}
		row++;
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

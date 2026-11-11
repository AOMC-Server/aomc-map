import { floorDiv } from "./coords";

/** Camera state. zoom is a float: css pixels per block = 2^-zoom (0 = 1:1, negative magnifies). */
export type View = { centerX: number; centerZ: number; zoom: number };
export type Size = { width: number; height: number };

export const MIN_ZOOM = -4;

export const scaleOf = (zoom: number) => 2 ** -zoom;

export function clampZoom(zoom: number, maxZoom: number): number {
	return Math.min(Math.max(zoom, MIN_ZOOM), maxZoom);
}

/**
 * The same place in another dimension. `scale` is overworld blocks per block of the dimension
 * (1 for the overworld, 8 for the Nether), or null when its coordinates can't be related to
 * others (the End), in which case there is no equivalent and this returns null.
 *
 * The view keeps showing the same area: one Nether block covers 8 overworld blocks, so going to
 * the Nether divides the coordinates by 8 and zooms in by 3 levels (log2 8).
 */
export function convertView(
	view: View,
	fromScale: number | null,
	toScale: number | null,
	maxZoom: number,
): View | null {
	if (fromScale === null || toScale === null) return null;
	const ratio = fromScale / toScale;
	return {
		centerX: view.centerX * ratio,
		centerZ: view.centerZ * ratio,
		zoom: clampZoom(view.zoom + Math.log2(ratio), maxZoom),
	};
}

export function screenToBlock(view: View, size: Size, sx: number, sy: number) {
	const s = scaleOf(view.zoom);
	return {
		x: view.centerX + (sx - size.width / 2) / s,
		z: view.centerZ + (sy - size.height / 2) / s,
	};
}

export function blockToScreen(view: View, size: Size, x: number, z: number) {
	const s = scaleOf(view.zoom);
	return {
		x: (x - view.centerX) * s + size.width / 2,
		y: (z - view.centerZ) * s + size.height / 2,
	};
}

/** Changes zoom while keeping the block under (sx, sy) fixed on screen. */
export function zoomAt(
	view: View,
	size: Size,
	sx: number,
	sy: number,
	zoom: number,
): View {
	const anchor = screenToBlock(view, size, sx, sy);
	const s = scaleOf(zoom);
	return {
		zoom,
		centerX: anchor.x - (sx - size.width / 2) / s,
		centerZ: anchor.z - (sy - size.height / 2) / s,
	};
}

/** Moves the camera so the content under the pointer follows a screen-space drag. */
export function panBy(view: View, dxPx: number, dyPx: number): View {
	const s = scaleOf(view.zoom);
	return {
		...view,
		centerX: view.centerX - dxPx / s,
		centerZ: view.centerZ - dyPx / s,
	};
}

/**
 * Tile level to draw: the coarsest level that never magnifies its pixels.
 *
 * One pixel of a level-L tile covers 2^L blocks, which is 2^(L - zoom) * dpr device pixels. That
 * is at most 1 exactly when L <= zoom - log2(dpr), hence the floor: tiles are shown at 1x down to
 * (just under) 2x reduced, never blurred by upscaling. Rounding up would pick a level whose
 * pixels are up to 2x too large.
 */
export function tileLevel(zoom: number, dpr: number, maxZoom: number): number {
	const level = Math.floor(zoom - Math.log2(dpr) + 1e-9);
	return Math.min(Math.max(level, 0), maxZoom);
}

export type TileRange = {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
};

/** Inclusive range of tile indices at `level` that intersect the viewport. */
export function visibleTiles(
	view: View,
	size: Size,
	level: number,
	tileSize: number,
): TileRange {
	const s = scaleOf(view.zoom);
	const span = tileSize * 2 ** level;
	const left = view.centerX - size.width / 2 / s;
	const right = view.centerX + size.width / 2 / s;
	const top = view.centerZ - size.height / 2 / s;
	const bottom = view.centerZ + size.height / 2 / s;
	return {
		minX: floorDiv(left, span),
		maxX: floorDiv(right, span),
		minY: floorDiv(top, span),
		maxY: floorDiv(bottom, span),
	};
}

/** Screen-space (css px) rectangle of a tile. */
export function tileRect(
	view: View,
	size: Size,
	level: number,
	tileSize: number,
	tx: number,
	ty: number,
) {
	const span = tileSize * 2 ** level;
	const a = blockToScreen(view, size, tx * span, ty * span);
	const b = blockToScreen(view, size, (tx + 1) * span, (ty + 1) * span);
	return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/** Floor division that rounds toward negative infinity (so -1 / 512 = -1). */
export function floorDiv(a: number, b: number): number {
	return Math.floor(a / b);
}

/** Zoom 0 tile index containing the given block coordinate. */
export function blockToTile(block: number, tileSize: number): number {
	return floorDiv(block, tileSize);
}

/** Parent tile index one zoom level further out. */
export function parentTile(index: number): number {
	return floorDiv(index, 2);
}

/** Inclusive range of zoom 0 tile indices touched by a block span [min, max]. */
export function tileRange(
	minBlock: number,
	maxBlock: number,
	tileSize: number,
): { min: number; max: number } {
	return {
		min: blockToTile(minBlock, tileSize),
		max: blockToTile(maxBlock, tileSize),
	};
}

import { signal } from "@preact/signals";
import { BLOCK_CENTER } from "../map/featureLayer";
import type { MapView } from "../map/MapView";
import type { Point } from "./measureMath";

/** Shift is held: points the tools place or drag snap to straight lines from their neighbour. */
export const shiftHeld = signal(false);

/** How close (css px) a press has to be to grab a point. */
export const GRAB_RADIUS = 12;

/** The block a fractional block position is in. */
export const floorBlock = (b: Point): Point => ({
	x: Math.floor(b.x),
	z: Math.floor(b.z),
});

/** The block under a screen position. */
export const blockAt = (map: MapView, sx: number, sy: number): Point =>
	floorBlock(map.screenToBlock(sx, sy));

/** Where the middle of a block is on screen. */
export const blockCenter = (map: MapView, p: Point) =>
	map.blockToScreen(p.x + BLOCK_CENTER, p.z + BLOCK_CENTER);

/** Index of the point nearest to the screen position, if one is within `radius`; otherwise -1. */
export function nearestHandle(
	map: MapView,
	points: Point[],
	sx: number,
	sy: number,
	radius = GRAB_RADIUS,
): number {
	let best = -1;
	let bestDist = radius;
	points.forEach((p, i) => {
		const s = blockCenter(map, p);
		const dist = Math.hypot(s.x - sx, s.y - sy);
		if (dist <= bestDist) {
			best = i;
			bestDist = dist;
		}
	});
	return best;
}

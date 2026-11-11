import { scaleOf, type View } from "@aomc/shared/view";

/** Closer than this to the goal, the zoom snaps onto it and the animation ends. */
const SNAP = 0.002;

const GRID_EPS = 1e-9;

/**
 * Where a zoom of `delta` levels from `base` ends up on a grid of multiples of `snap`: the grid
 * line nearest `ahead` (the unsnapped goal), but never back at or behind `base`, so a small
 * notch of the wheel still moves one whole step in its direction instead of rounding to nothing.
 * Steps that would leave `[lo, hi]` stay at `base`.
 */
export function snapZoomGoal(
	base: number,
	ahead: number,
	delta: number,
	snap: number,
	lo: number,
	hi: number,
): number {
	let goal = Math.round(ahead / snap) * snap;
	if (delta !== 0 && (goal - base) * Math.sign(delta) <= GRID_EPS) {
		const k = base / snap;
		goal =
			(delta > 0 ? Math.floor(k + GRID_EPS) + 1 : Math.ceil(k - GRID_EPS) - 1) *
			snap;
	}
	return goal < lo || goal > hi ? Math.min(Math.max(base, lo), hi) : goal;
}

/**
 * One frame of easing the zoom toward its goal. The remaining distance shrinks exponentially
 * with time constant `smoothing` (ms), so the result does not depend on the frame rate, it slows
 * down as it arrives and never overshoots.
 */
export function easeZoom(
	current: number,
	goal: number,
	dtMs: number,
	smoothing: number,
): number {
	const diff = goal - current;
	// No smoothing means no easing: go straight there.
	if (smoothing <= 0 || Math.abs(diff) < SNAP) return goal;
	const next = current + diff * (1 - Math.exp(-Math.max(dtMs, 0) / smoothing));
	return Math.abs(goal - next) < SNAP ? goal : next;
}

/**
 * The view a fraction `e` (0 to 1, already eased) of the way from `from` to `to`, moving in a
 * straight line on screen.
 *
 * The zoom changes exponentially (a level is a doubling), so moving the centre by the same
 * fraction of the distance would make the pan lag behind the zoom when zooming in, and race
 * ahead of it when zooming out. Instead the pan fraction is chosen so that a point is carried in
 * a straight line at constant screen speed: the destination when zooming in (it glides to the
 * middle), the starting point when zooming out (it glides away from the middle). Without a zoom
 * change this is a plain linear pan.
 */
export function tweenView(from: View, to: View, e: number): View {
	const ratio = scaleOf(to.zoom) / scaleOf(from.zoom);
	const pan = ratio >= 1 ? 1 - (1 - e) * ratio ** -e : e * ratio ** (1 - e);
	return {
		zoom: from.zoom + (to.zoom - from.zoom) * e,
		centerX: from.centerX + (to.centerX - from.centerX) * pan,
		centerZ: from.centerZ + (to.centerZ - from.centerZ) * pan,
	};
}

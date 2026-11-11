/** Closer than this to the goal, the zoom snaps onto it and the animation ends. */
const SNAP = 0.002;

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
	if (Math.abs(diff) < SNAP) return goal;
	const next = current + diff * (1 - Math.exp(-Math.max(dtMs, 0) / smoothing));
	return Math.abs(goal - next) < SNAP ? goal : next;
}

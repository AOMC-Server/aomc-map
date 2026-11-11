import { describe, expect, test } from "bun:test";
import { scaleOf } from "@aomc/shared/view";
import { easeZoom, snapZoomGoal, tweenView } from "./smoothZoom";

describe("easeZoom", () => {
	test("moves toward the goal without overshooting, in both directions", () => {
		for (const goal of [3, -3]) {
			let z = 0;
			for (let i = 0; i < 10; i++) {
				const next = easeZoom(z, goal, 16, 80);
				expect(Math.abs(goal - next)).toBeLessThan(Math.abs(goal - z));
				expect(Math.sign(goal - next)).not.toBe(-Math.sign(goal));
				z = next;
			}
		}
	});

	test("arrives exactly, in a bounded number of frames", () => {
		let z = 0;
		let frames = 0;
		while (z !== 2 && frames < 1000) {
			z = easeZoom(z, 2, 16, 80);
			frames++;
		}
		expect(z).toBe(2);
		expect(frames).toBeLessThan(60);
	});

	test("does not depend on the frame rate", () => {
		const once = easeZoom(0, 1, 32, 80);
		const twice = easeZoom(easeZoom(0, 1, 16, 80), 1, 16, 80);
		expect(twice).toBeCloseTo(once, 9);
	});

	test("a frame of no time changes nothing", () => {
		expect(easeZoom(0.5, 2, 0, 80)).toBe(0.5);
		expect(easeZoom(0.5, 2, -5, 80)).toBe(0.5);
	});
});

describe("easeZoom without smoothing", () => {
	test("goes straight to the goal", () => {
		expect(easeZoom(0, 3, 16, 0)).toBe(3);
		expect(easeZoom(0, -3, 0, 0)).toBe(-3);
	});
});

describe("tweenView", () => {
	const at = (from: number, to: number) => ({
		from: { centerX: 100, centerZ: -40, zoom: from },
		to: { centerX: 900, centerZ: 360, zoom: to },
	});
	const steps = Array.from({ length: 21 }, (_, i) => i / 20);

	test("starts and ends on the given views", () => {
		const { from, to } = at(3, -2);
		expect(tweenView(from, to, 0)).toEqual(from);
		expect(tweenView(from, to, 1)).toEqual(to);
	});

	test("without a zoom change it is a linear pan", () => {
		const { from, to } = at(1, 1);
		for (const e of steps) {
			const v = tweenView(from, to, e);
			expect(v.centerX).toBeCloseTo(100 + 800 * e, 6);
			expect(v.centerZ).toBeCloseTo(-40 + 400 * e, 6);
		}
	});

	test("zooming in: the destination glides to the middle in a straight line", () => {
		const { from, to } = at(2, -3);
		for (const e of steps) {
			const v = tweenView(from, to, e);
			const s = scaleOf(v.zoom);
			// Its distance from the middle of the screen shrinks linearly with progress.
			expect((to.centerX - v.centerX) * s).toBeCloseTo(
				(1 - e) * (to.centerX - from.centerX) * scaleOf(from.zoom),
				6,
			);
			expect((to.centerZ - v.centerZ) * s).toBeCloseTo(
				(1 - e) * (to.centerZ - from.centerZ) * scaleOf(from.zoom),
				6,
			);
		}
	});

	test("zooming out: the starting point glides away in a straight line", () => {
		const { from, to } = at(-3, 2);
		for (const e of steps) {
			const v = tweenView(from, to, e);
			const s = scaleOf(v.zoom);
			expect((from.centerX - v.centerX) * s).toBeCloseTo(
				e * (from.centerX - to.centerX) * scaleOf(to.zoom),
				6,
			);
		}
	});

	test("the centre only ever moves toward the destination", () => {
		for (const [a, b] of [
			[4, -4],
			[-4, 4],
			[0, 1],
		] as const) {
			const { from, to } = at(a, b);
			let last = -1;
			for (const e of steps) {
				const x = (tweenView(from, to, e).centerX - from.centerX) / 800;
				expect(x).toBeGreaterThanOrEqual(last - 1e-9);
				expect(x).toBeGreaterThanOrEqual(-1e-9);
				expect(x).toBeLessThanOrEqual(1 + 1e-9);
				last = x;
			}
		}
	});
});

describe("snapZoomGoal", () => {
	const snap = (base: number, delta: number, lo = -10, hi = 10) =>
		snapZoomGoal(base, base + delta, delta, 0.5, lo, hi);

	test("rounds to the nearest grid line when that moves in the right direction", () => {
		expect(snap(0, 0.4)).toBe(0.5);
		expect(snap(0, -0.4)).toBe(-0.5);
		expect(snap(0.3, 0.2)).toBe(0.5);
	});

	test("a notch too small to reach the next line still moves one whole step", () => {
		// Firefox: 3 lines of 16 px at 0.005 per px = 0.24 levels.
		expect(snap(0, 0.24)).toBe(0.5);
		expect(snap(0, -0.24)).toBe(-0.5);
		expect(snap(1.5, 0.24)).toBe(2);
		expect(snap(1.5, -0.24)).toBe(1);
	});

	test("never moves against the direction of the notch", () => {
		// Off the grid, plain rounding of 0.7 + 0.04 would go back to 0.5.
		expect(snap(0.7, 0.04)).toBe(1);
		expect(snap(0.3, -0.04)).toBe(0);
	});

	test("repeated notches walk along the grid", () => {
		let goal = 0;
		for (let i = 0; i < 4; i++) goal = snap(goal, 0.24);
		expect(goal).toBe(2);
		for (let i = 0; i < 4; i++) goal = snap(goal, -0.24);
		expect(goal).toBe(0);
	});

	test("stops at the edge of the allowed range instead of running away", () => {
		expect(snap(2, 0.24, -2, 2)).toBe(2);
		expect(snap(-2, -0.24, -2, 2)).toBe(-2);
	});

	test("a zero delta just rounds", () => {
		expect(snapZoomGoal(0.3, 0.3, 0, 0.5, -10, 10)).toBe(0.5);
	});
});

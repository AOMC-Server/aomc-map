import { describe, expect, test } from "bun:test";
import { dashRuns, newDashState, stepDashes } from "./dashRuns";
import type { Pt } from "./geometry";
import { smoothShape } from "./smooth";

const square: Pt[] = [
	[0, 0],
	[100, 0],
	[100, 100],
	[0, 100],
];
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Where in the dash pattern the point `d` blocks along a run (from its vertex 0) is drawn. */
function phaseAt(
	run: ReturnType<typeof dashRuns>[0],
	state: ReturnType<typeof newDashState>,
	d: number,
	scale: number,
	period: number,
) {
	const fromSeam = run.closed
		? mod(d - (run.at[state.seam] ?? 0), run.length)
		: d;
	return mod(fromSeam * scale + state.offset, period);
}

describe("dashRuns", () => {
	test("an area is one closed run", () => {
		const [run] = dashRuns("polygon", [square], null);
		expect(run?.closed).toBe(true);
		expect(run?.pieces).toHaveLength(4);
		expect(run?.length).toBe(400);
		expect(run?.at).toEqual([0, 100, 200, 300, 400]);
	});

	test("a line that comes back to its start is a loop", () => {
		const runs = dashRuns("line", [[...square, square[0] as Pt]], null);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.closed).toBe(true);
		expect(runs[0]?.length).toBe(400);
	});

	test("an open line is one open run", () => {
		const runs = dashRuns("line", [square], null);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.closed).toBe(false);
		expect(runs[0]?.length).toBe(300);
	});

	test("a smooth area is measured along its curve", () => {
		const smooth = smoothShape("polygon", [square]);
		const [run] = dashRuns("polygon", [square], smooth);
		expect(run?.closed).toBe(true);
		expect(run?.pieces).toHaveLength(4);
		expect(run?.length).toBeGreaterThan(300);
		expect(run?.at.at(-1)).toBeCloseTo(run?.length ?? 0, 5);
	});
});

describe("stepDashes", () => {
	const period = 12;

	test("panning moves nothing", () => {
		const [run] = dashRuns("line", [square], null);
		if (!run) throw new Error();
		const s = stepDashes(
			run,
			{ offset: 5, seam: 0, cycles: null },
			1,
			period,
			null,
		);
		expect(s.offset).toBe(5);
	});

	test("the dashes nearest the zoom point stay still", () => {
		const [run] = dashRuns("line", [square], null);
		if (!run) throw new Error();
		const before = newDashState();
		// Zoom about (100, 37): 137 blocks along the line.
		const after = stepDashes(run, before, 1.3, period, {
			x: 100,
			z: 37,
			from: 1,
		});
		expect(phaseAt(run, after, 137, 1.3, period)).toBeCloseTo(
			phaseAt(run, before, 137, 1, period),
			6,
		);
	});

	test("on a loop, zooming near the seam keeps the dashes there still on both sides", () => {
		const [run] = dashRuns("polygon", [square], null);
		if (!run) throw new Error();
		let state = stepDashes(run, newDashState(), 1, period, null);
		let scale = 1;
		// Zoom in steadily near vertex 0, where the seam starts.
		for (let i = 0; i < 400; i++) {
			const to = scale * 1.002;
			const prev = state;
			state = stepDashes(run, state, to, period, {
				x: 2,
				z: 0,
				from: scale,
			});
			// Just after the zoom point, on the same side of the seam as it.
			expect(
				Math.abs(
					mod(
						phaseAt(run, state, 2, to, period) -
							phaseAt(run, prev, 2, scale, period) +
							period / 2,
						period,
					) -
						period / 2,
				),
			).toBeLessThan(1e-6);
			scale = to;
		}
		// The seam has gone to the far side of the loop.
		expect(state.seam).toBe(2);
		// So just before the zoom point (across the old seam) is still too.
		const prev = state;
		const to = scale * 1.002;
		state = stepDashes(run, state, to, period, { x: 2, z: 0, from: scale });
		const before = phaseAt(run, prev, 398, scale, period);
		const now = phaseAt(run, state, 398, to, period);
		expect(
			Math.abs(mod(now - before + period / 2, period) - period / 2),
		).toBeLessThan(0.05);
	});

	test("moving the seam moves no dash more than zooming moves them anyway", () => {
		const [run] = dashRuns("polygon", [square], null);
		if (!run) throw new Error();
		let state = stepDashes(run, newDashState(), 1, period, null);
		let scale = 1;
		let moves = 0;
		for (let i = 0; i < 400; i++) {
			const to = scale * 1.002;
			const prev = state;
			state = stepDashes(run, state, to, period, {
				x: 2,
				z: 0,
				from: scale,
			});
			if (state.seam !== prev.seam) {
				moves++;
				// Before the seam moves, a point across it from the zoom point slides by up to the
				// whole loop in a frame; moving the seam adds no more than that.
				const slide = 400 * (to - scale) + 1e-6;
				for (let d = 0; d < 400; d += 7) {
					const diff = mod(
						phaseAt(run, state, d, to, period) -
							phaseAt(run, prev, d, scale, period) +
							period / 2,
						period,
					);
					expect(Math.abs(diff - period / 2)).toBeLessThan(slide);
				}
			}
			scale = to;
		}
		expect(moves).toBeGreaterThan(0);
	});

	test("a seam past the end of an edited shape starts again at its first vertex", () => {
		const [run] = dashRuns("polygon", [square], null);
		if (!run) throw new Error();
		expect(
			stepDashes(run, { offset: 0, seam: 9, cycles: 3 }, 1, period, null).seam,
		).toBe(0);
	});
});

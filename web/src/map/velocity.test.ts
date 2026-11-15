import { describe, expect, test } from "bun:test";
import { fitVelocity } from "./velocity";

describe("fitVelocity", () => {
	test("the slope of values changing steadily", () => {
		const samples = [0, 10, 20, 30].map((t) => ({ t, v: [t * 0.5, 7 - t] }));
		const [a, b] = fitVelocity(samples) as number[];
		expect(a).toBeCloseTo(0.5);
		expect(b).toBeCloseTo(-1);
	});

	test("one jittery reading at the end only nudges the speed", () => {
		const samples = [0, 10, 20, 30, 40, 50].map((t) => ({ t, v: [t] }));
		// Pulled back as far as the reading before it: from two readings this would be 0.
		samples.push({ t: 60, v: [50] });
		const [v] = fitVelocity(samples) as number[];
		expect(v).toBeGreaterThan(0.75);
	});

	test("readings handled together are told apart by their event times", () => {
		const v = fitVelocity([
			{ t: 0, v: [0] },
			{ t: 16, v: [16] },
			{ t: 16, v: [16] },
			{ t: 32, v: [32] },
		]);
		expect(v?.[0]).toBeCloseTo(1);
	});

	test("no speed without readings spread over time", () => {
		expect(fitVelocity([])).toBeNull();
		expect(fitVelocity([{ t: 5, v: [1] }])).toBeNull();
		expect(
			fitVelocity([
				{ t: 5, v: [1] },
				{ t: 5, v: [3] },
			]),
		).toBeNull();
	});
});

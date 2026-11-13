import { describe, expect, test } from "bun:test";
import { featureStats } from "./featureInfo";

describe("featureStats", () => {
	test("a pin has none", () => {
		expect(featureStats({ type: "pin", geometry: [1, 2] })).toEqual({});
	});

	test("a line has its length, and a branch adds to it", () => {
		const path = [
			[0, 0],
			[30, 40],
		];
		expect(featureStats({ type: "line", geometry: path })).toEqual({
			length: 50,
		});
		const forked = {
			type: "line" as const,
			geometry: [
				path,
				[
					[30, 40],
					[30, 140],
				],
			],
		};
		expect(featureStats(forked).length).toBe(150);
	});

	test("a loop line counts every side once", () => {
		const square = [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		];
		expect(featureStats({ type: "line", geometry: square }).length).toBe(40);
	});

	test("an area has a perimeter and an area", () => {
		const f = {
			type: "polygon" as const,
			geometry: [
				[0, 0],
				[100, 0],
				[100, 50],
				[0, 50],
			],
		};
		expect(featureStats(f)).toEqual({ perimeter: 300, area: 5000 });
		// Asking again gives the cached result.
		expect(featureStats(f)).toBe(featureStats(f));
	});

	test("measured along the curve when smoothed", () => {
		const bend = [
			[0, 0],
			[100, 0],
			[100, 100],
		];
		const straight = featureStats({ type: "line", geometry: bend }).length ?? 0;
		const curved =
			featureStats({ type: "line", geometry: bend }, true).length ?? 0;
		expect(straight).toBe(200);
		// A curve through the same points cuts the corner... or bulges; either way it is not 200.
		expect(Math.abs(curved - straight)).toBeGreaterThan(0.5);
		expect(curved).toBeLessThan(straight * 1.2);
		const square = {
			type: "polygon" as const,
			geometry: [
				[0, 0],
				[100, 0],
				[100, 100],
				[0, 100],
			],
		};
		const plain = featureStats(square);
		const round = featureStats(square, true);
		expect(plain.perimeter).toBe(400);
		expect(round.perimeter).toBeGreaterThan(400);
		expect(round.area).toBeGreaterThan(10_000);
		// Both are kept, one does not replace the other.
		expect(featureStats(square)).toBe(plain);
		expect(featureStats(square, true)).toBe(round);
	});
});

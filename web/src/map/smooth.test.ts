import { describe, expect, test } from "bun:test";
import type { Pt } from "./geometry";
import {
	type Bezier,
	chainsOf,
	polylineArea,
	polylineLength,
	segmentKey,
	segmentMids,
	smoothShape,
} from "./smooth";

const bend: Pt[] = [
	[0, 0],
	[100, 0],
	[100, 100],
	[200, 100],
];
const square: Pt[] = [
	[0, 0],
	[100, 0],
	[100, 100],
	[0, 100],
];
/** A road with a side road from its middle. */
const fork: Pt[][] = [
	[
		[0, 0],
		[100, 0],
		[200, 0],
	],
	[
		[100, 0],
		[100, 100],
	],
];

describe("chainsOf", () => {
	test("a plain path is one chain, in order", () => {
		expect(chainsOf([bend])).toEqual([{ points: bend, closed: false }]);
	});

	test("a fork ends three chains at the junction, whatever the paths were", () => {
		const chains = chainsOf(fork);
		expect(chains).toHaveLength(3);
		for (const c of chains) {
			expect(c.closed).toBe(false);
			expect(c.points).toHaveLength(2);
			expect(c.points.some((p) => p[0] === 100 && p[1] === 0)).toBe(true);
		}
		// The same line cut into paths another way gives the same chains.
		const other = chainsOf([
			[
				[0, 0],
				[100, 0],
			],
			[
				[100, 100],
				[100, 0],
				[200, 0],
			],
		]);
		const key = (cs: typeof chains) =>
			cs.map((c) => c.points.map(String).sort().join("|")).sort();
		expect(key(other)).toEqual(key(chains));
	});

	test("a loop without a fork is one closed chain", () => {
		const chains = chainsOf([[...square, square[0] as Pt]]);
		expect(chains).toHaveLength(1);
		expect(chains[0]?.closed).toBe(true);
		expect(chains[0]?.points).toHaveLength(4);
	});

	test("a loop through a fork is cut at it", () => {
		const lollipop: Pt[][] = [
			[...square, square[0] as Pt],
			[
				[0, 0],
				[-100, -100],
			],
		];
		const chains = chainsOf(lollipop);
		expect(chains).toHaveLength(2);
		expect(chains.every((c) => !c.closed)).toBe(true);
	});

	test("separate parts are separate chains", () => {
		expect(
			chainsOf([
				bend,
				[
					[500, 500],
					[600, 500],
				],
			]),
		).toHaveLength(2);
	});
});

describe("smoothShape", () => {
	test("the curve goes through every point", () => {
		const { strokes } = smoothShape("line", [bend]);
		expect(strokes).toHaveLength(1);
		const through = [
			strokes[0]?.start,
			...(strokes[0]?.beziers.map((b) => b[2]) ?? []),
		];
		expect(through).toEqual(bend);
		for (const p of bend) {
			expect(
				strokes[0]?.samples.some((s) => s[0] === p[0] && s[1] === p[1]),
			).toBe(true);
		}
	});

	test("two points stay a straight line", () => {
		const { strokes } = smoothShape("line", [
			[
				[0, 0],
				[90, 30],
			],
		]);
		for (const [x, z] of strokes[0]?.samples ?? [])
			expect(Math.abs(z - x / 3)).toBeLessThan(1e-9);
	});

	test("a curve is longer than the straight lines through its points, but not by much", () => {
		const curved = smoothShape("line", [bend]).strokes[0]?.samples ?? [];
		const straight = polylineLength(bend);
		expect(polylineLength(curved)).toBeGreaterThan(straight - 1e-9);
		expect(polylineLength(curved)).toBeLessThan(straight * 1.2);
	});

	test("an area is a closed curve with a rounded corner, smaller than its square", () => {
		const { strokes } = smoothShape("polygon", [square]);
		const stroke = strokes[0];
		expect(stroke?.closed).toBe(true);
		const samples = stroke?.samples ?? [];
		expect(samples[0]).toEqual(samples.at(-1));
		const area = polylineArea(samples);
		// Passing through the corners of a square it still fills most of it, and the curve bulges
		// out of it between them (a circle through the corners would be about 1.57 times larger).
		expect(area).toBeGreaterThan(8_000);
		expect(area).toBeLessThan(15_700);
	});

	test("a closed curve has no corner where it starts", () => {
		const stroke = smoothShape("polygon", [square]).strokes[0];
		const first = stroke?.beziers[0] as Bezier;
		const last = stroke?.beziers.at(-1) as Bezier;
		const start = stroke?.start as Pt;
		// The curve leaves the start in the direction it arrived in.
		const out = [first[0][0] - start[0], first[0][1] - start[1]] as const;
		const into = [start[0] - last[1][0], start[1] - last[1][1]] as const;
		const cross = out[0] * into[1] - out[1] * into[0];
		const dot = out[0] * into[0] + out[1] * into[1];
		expect(Math.abs(cross)).toBeLessThan(1e-6 * Math.abs(dot));
		expect(dot).toBeGreaterThan(0);
	});

	test("a fork is a corner: each branch is its own curve", () => {
		expect(smoothShape("line", fork).strokes).toHaveLength(3);
	});

	test("the bounds hold the whole curve", () => {
		const { bounds, strokes } = smoothShape("line", [bend]);
		for (const [x, z] of strokes.flatMap((s) => s.samples)) {
			expect(x).toBeGreaterThanOrEqual(bounds.minX);
			expect(x).toBeLessThanOrEqual(bounds.maxX);
			expect(z).toBeGreaterThanOrEqual(bounds.minZ);
			expect(z).toBeLessThanOrEqual(bounds.maxZ);
		}
	});

	test("repeated points do not break it", () => {
		const { strokes } = smoothShape("polygon", [
			[
				[0, 0],
				[0, 0],
				[100, 0],
				[100, 100],
			],
		]);
		for (const [x, z] of strokes[0]?.samples ?? []) {
			expect(Number.isFinite(x)).toBe(true);
			expect(Number.isFinite(z)).toBe(true);
		}
	});
});

describe("segmentMids", () => {
	const g: Pt[] = [
		[0, 0],
		[300, 0],
		[300, 300],
		[600, 300],
	];
	const mids = segmentMids(smoothShape("line", [g]));

	test("has the middle of the curve of every segment, whichever way round it is asked", () => {
		expect(mids.size).toBe(3);
		expect(mids.get(segmentKey(g[0] as Pt, g[1] as Pt))).toEqual(
			mids.get(segmentKey(g[1] as Pt, g[0] as Pt)),
		);
	});

	test("is on the curve, off the straight segment where the line bends", () => {
		const mid = mids.get(segmentKey(g[0] as Pt, g[1] as Pt)) as Pt;
		expect(Math.abs(mid[1])).toBeGreaterThan(10);
		const samples = smoothShape("line", [g]).strokes.flatMap((s) => s.samples);
		const nearest = Math.min(
			...samples.map((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1])),
		);
		expect(nearest).toBeLessThan(5);
	});

	test("of a straight line is the middle of it", () => {
		const straight = smoothShape("line", [
			[
				[0, 0],
				[100, 40],
			],
		]);
		const [mid] = [...segmentMids(straight).values()];
		expect(mid?.[0]).toBeCloseTo(50);
		expect(mid?.[1]).toBeCloseTo(20);
	});

	test("of a closed curve includes the segment that closes it", () => {
		const ring = smoothShape("polygon", [square]);
		expect(segmentMids(ring).size).toBe(4);
		expect(
			segmentMids(ring).has(segmentKey(square[3] as Pt, square[0] as Pt)),
		).toBe(true);
	});
});

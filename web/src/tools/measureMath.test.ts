import { describe, expect, test } from "bun:test";
import {
	facing,
	formatDuration,
	midpoint,
	pathLength,
	polygonArea,
	segmentIndices,
	segmentLengths,
	snapToLine,
} from "./measureMath";

describe("segmentLengths", () => {
	test("one length per pair of consecutive points", () => {
		expect(segmentLengths([])).toEqual([]);
		expect(segmentLengths([{ x: 0, z: 0 }])).toEqual([]);
		expect(
			segmentLengths([
				{ x: 0, z: 0 },
				{ x: 3, z: 4 },
				{ x: 3, z: -6 },
			]),
		).toEqual([5, 10]);
	});
});

describe("facing", () => {
	test("names the eight compass directions; north is -z", () => {
		expect(facing(0, -10).name).toBe("north");
		expect(facing(10, -10).name).toBe("north-east");
		expect(facing(10, 0).name).toBe("east");
		expect(facing(10, 10).name).toBe("south-east");
		expect(facing(0, 10).name).toBe("south");
		expect(facing(-10, 10).name).toBe("south-west");
		expect(facing(-10, 0).name).toBe("west");
		expect(facing(-10, -10).name).toBe("north-west");
	});

	test("yaw matches the F3 screen", () => {
		expect(facing(0, 10).yaw).toBe(0);
		expect(facing(-10, 0).yaw).toBe(90);
		expect(facing(0, -10).yaw).toBe(180);
		expect(facing(10, 0).yaw).toBe(-90);
		expect(facing(10, -10).yaw).toBeCloseTo(-135, 9);
	});
});

describe("snapToLine", () => {
	const from = { x: 10, z: 10 };

	test("snaps to the x or z axis when close to it", () => {
		expect(snapToLine(from, { x: 50, z: 13 })).toEqual({ x: 50, z: 10 });
		expect(snapToLine(from, { x: 8, z: -40 })).toEqual({ x: 10, z: -40 });
	});

	test("snaps to a 45° diagonal when close to one", () => {
		expect(snapToLine(from, { x: 30, z: 32 })).toEqual({ x: 31, z: 31 });
		expect(snapToLine(from, { x: -10, z: 28 })).toEqual({ x: -9, z: 29 });
	});
});

describe("formatDuration", () => {
	test("seconds, minutes and hours", () => {
		expect(formatDuration(44.6)).toBe("45s");
		expect(formatDuration(185)).toBe("3m 05s");
		expect(formatDuration(7620)).toBe("2h 07m");
	});
});

describe("segmentIndices and pathLength", () => {
	const square = [
		{ x: 0, z: 0 },
		{ x: 10, z: 0 },
		{ x: 10, z: 10 },
		{ x: 0, z: 10 },
	];

	test("a path has n-1 segments, a closed one joins the end to the start", () => {
		expect(segmentIndices(3)).toEqual([
			[0, 1],
			[1, 2],
		]);
		expect(segmentIndices(3, true)).toEqual([
			[0, 1],
			[1, 2],
			[2, 0],
		]);
		expect(segmentIndices(2, true)).toEqual([[0, 1]]);
		expect(segmentIndices(1)).toEqual([]);
	});

	test("lengths, open and closed", () => {
		expect(pathLength(square)).toBe(30);
		expect(pathLength(square, true)).toBe(40);
		expect(pathLength([{ x: 3, z: 4 }])).toBe(0);
		expect(
			pathLength(
				[
					{ x: 0, z: 0 },
					{ x: 3, z: 4 },
				],
				true,
			),
		).toBe(5);
	});

	test("area does not depend on the direction, and is 0 without a surface", () => {
		expect(polygonArea(square)).toBe(100);
		expect(polygonArea([...square].reverse())).toBe(100);
		expect(polygonArea(square.slice(0, 2))).toBe(0);
	});
});

describe("midpoint", () => {
	test("is the whole block halfway, rounding down", () => {
		expect(midpoint({ x: 0, z: 0 }, { x: 10, z: 4 })).toEqual({ x: 5, z: 2 });
		expect(midpoint({ x: -3, z: 0 }, { x: 0, z: 1 })).toEqual({ x: -2, z: 0 });
	});
});

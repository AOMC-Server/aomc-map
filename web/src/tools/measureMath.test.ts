import { describe, expect, test } from "bun:test";
import {
	facing,
	formatDuration,
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

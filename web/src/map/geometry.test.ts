import { describe, expect, test } from "bun:test";
import {
	arcLengthAt,
	boundsOf,
	distToPolyline,
	distToSegment,
	intersects,
	type Pt,
	pointInPolygon,
} from "./geometry";

describe("distToSegment", () => {
	test("perpendicular, endpoint and degenerate cases", () => {
		expect(distToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
		expect(distToSegment(-4, 3, 0, 0, 10, 0)).toBe(5);
		expect(distToSegment(13, 4, 0, 0, 10, 0)).toBe(5);
		expect(distToSegment(3, 4, 0, 0, 0, 0)).toBe(5);
	});
});

describe("distToPolyline", () => {
	const square = [
		[0, 0],
		[10, 0],
		[10, 10],
		[0, 10],
	] as const;
	test("open polyline ignores the closing edge", () => {
		expect(distToPolyline(0, 5, square)).toBe(5);
	});
	test("closed polygon includes it", () => {
		expect(distToPolyline(0, 5, square, true)).toBe(0);
	});
});

describe("pointInPolygon", () => {
	const concave = [
		[0, 0],
		[10, 0],
		[10, 10],
		[5, 4],
		[0, 10],
	] as const;
	test("inside, outside and in the concave notch", () => {
		expect(pointInPolygon(2, 2, concave)).toBe(true);
		expect(pointInPolygon(8, 2, concave)).toBe(true);
		expect(pointInPolygon(5, 8, concave)).toBe(false);
		expect(pointInPolygon(-1, 5, concave)).toBe(false);
		expect(pointInPolygon(20, 5, concave)).toBe(false);
	});
	test("works with negative coordinates", () => {
		const tri = [
			[-10, -10],
			[-2, -10],
			[-6, -3],
		] as const;
		expect(pointInPolygon(-6, -8, tri)).toBe(true);
		expect(pointInPolygon(-1, -3, tri)).toBe(false);
	});
});

describe("bounds", () => {
	test("boundsOf and intersects", () => {
		const b = boundsOf([
			[3, -4],
			[-2, 9],
			[7, 1],
		]);
		expect(b).toEqual({ minX: -2, minZ: -4, maxX: 7, maxZ: 9 });
		expect(intersects(b, { minX: 7, minZ: 9, maxX: 20, maxZ: 20 })).toBe(true);
		expect(intersects(b, { minX: 8, minZ: 0, maxX: 20, maxZ: 20 })).toBe(false);
	});
});

describe("arcLengthAt", () => {
	const l: Pt[] = [
		[0, 0],
		[10, 0],
		[10, 10],
	];

	test("is how far along the line its nearest point is", () => {
		expect(arcLengthAt(4, 3, l)).toBe(4);
		expect(arcLengthAt(14, 6, l)).toBe(16);
		expect(arcLengthAt(-5, 0, l)).toBe(0);
		expect(arcLengthAt(10, 50, l)).toBe(20);
	});
});

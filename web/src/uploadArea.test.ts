import { describe, expect, test } from "bun:test";
import { outlineTiles } from "./uploadArea";

describe("outlineTiles", () => {
	test("one tile is a square of four edges", () => {
		const { rects, edges } = outlineTiles([[1, 2]], 10);
		expect(rects).toEqual([{ x0: 10, z0: 20, x1: 20, z1: 30 }]);
		expect(edges).toHaveLength(4);
	});

	test("neighbouring tiles share no edge and sides on a line are joined", () => {
		// An L: three across, one below the left end.
		const { edges } = outlineTiles(
			[
				[0, 0],
				[1, 0],
				[2, 0],
				[0, 1],
			],
			1,
		);
		expect(edges).toHaveLength(6);
		expect(edges).toContainEqual({ x0: 0, z0: 0, x1: 3, z1: 0 });
		expect(edges).toContainEqual({ x0: 0, z0: 0, x1: 0, z1: 2 });
	});

	test("far apart tiles are outlined separately", () => {
		const { rects, edges } = outlineTiles(
			[
				[0, 0],
				[100, -50],
			],
			512,
		);
		expect(rects).toHaveLength(2);
		expect(edges).toHaveLength(8);
	});
});

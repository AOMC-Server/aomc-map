import { describe, expect, test } from "bun:test";
import { gridLines, mapArea } from "./debugLayer";

describe("gridLines", () => {
	test("lists the multiples of the span inside the viewport", () => {
		// zoom 0: one css px per block, so a 64×32 viewport centred on 0,0 spans -32..32, -16..16.
		const { xs, zs } = gridLines(
			{ centerX: 0, centerZ: 0, zoom: 0 },
			{ width: 64, height: 32 },
			16,
		);
		expect(xs).toEqual([-32, -16, 0, 16, 32]);
		expect(zs).toEqual([-16, 0, 16]);
	});

	test("lines are aligned to the world, not the view", () => {
		const { xs } = gridLines(
			{ centerX: 5, centerZ: 0, zoom: 0 },
			{ width: 40, height: 1 },
			16,
		);
		expect(xs).toEqual([0, 16]);
	});

	test("lines can start from an origin other than 0", () => {
		const { xs } = gridLines(
			{ centerX: 0, centerZ: 0, zoom: 0 },
			{ width: 400, height: 1 },
			128,
			-64,
		);
		expect(xs).toEqual([-192, -64, 64, 192]);
	});
});

describe("mapArea", () => {
	test("a 1:1 map around the origin spans -64 to 64", () => {
		expect(mapArea(0, 0)).toEqual({ min: -64, max: 64, centre: 0 });
		expect(mapArea(-65, 0)).toEqual({ min: -192, max: -64, centre: -128 });
		expect(mapArea(64, 0)).toEqual({ min: 64, max: 192, centre: 128 });
	});

	test("larger scales share the same grid origin", () => {
		expect(mapArea(0, 1)).toEqual({ min: -64, max: 192, centre: 64 });
		expect(mapArea(-100, 4)).toEqual({ min: -2112, max: -64, centre: -1088 });
	});
});

import { describe, expect, test } from "bun:test";
import { gridLines } from "./debugLayer";

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
});

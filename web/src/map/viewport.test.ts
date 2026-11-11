import { describe, expect, test } from "bun:test";
import { viewportBlocks } from "./viewport";

describe("viewportBlocks", () => {
	test("is the block rectangle behind the screen", () => {
		// zoom 1: two blocks per css px.
		expect(
			viewportBlocks(
				{ centerX: 10, centerZ: -4, zoom: 1 },
				{ width: 100, height: 50 },
			),
		).toEqual({ minX: -90, minZ: -54, maxX: 110, maxZ: 46 });
	});

	test("grows by the margin on every side", () => {
		expect(
			viewportBlocks(
				{ centerX: 0, centerZ: 0, zoom: 0 },
				{ width: 20, height: 10 },
				5,
			),
		).toEqual({ minX: -15, minZ: -10, maxX: 15, maxZ: 10 });
	});
});

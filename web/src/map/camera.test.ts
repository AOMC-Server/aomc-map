import { describe, expect, test } from "bun:test";
import {
	blockToScreen,
	clampZoom,
	convertView,
	panBy,
	screenToBlock,
	tileLevel,
	tileRect,
	type View,
	visibleTiles,
	zoomAt,
} from "./camera";

const size = { width: 800, height: 600 };
const view: View = { centerX: 100, centerZ: -50, zoom: 0 };

describe("projection", () => {
	test("the centre of the screen is the centre of the view", () => {
		expect(screenToBlock(view, size, 400, 300)).toEqual({ x: 100, z: -50 });
		expect(blockToScreen(view, size, 100, -50)).toEqual({ x: 400, y: 300 });
	});

	test("round trip at fractional zoom", () => {
		const v = { centerX: -1234.5, centerZ: 99, zoom: 2.37 };
		const b = screenToBlock(v, size, 123, 456);
		const s = blockToScreen(v, size, b.x, b.z);
		expect(s.x).toBeCloseTo(123, 6);
		expect(s.y).toBeCloseTo(456, 6);
	});

	test("zoom 0 is 1 px per block, zoom -2 is 4 px, zoom 3 is 1/8 px", () => {
		expect(blockToScreen({ ...view, zoom: 0 }, size, 101, -50).x).toBe(401);
		expect(blockToScreen({ ...view, zoom: -2 }, size, 101, -50).x).toBe(404);
		expect(blockToScreen({ ...view, zoom: 3 }, size, 108, -50).x).toBe(401);
	});
});

describe("zoomAt", () => {
	test("keeps the block under the cursor fixed", () => {
		for (const zoom of [-3, 0.5, 4]) {
			const before = screenToBlock(view, size, 650, 120);
			const next = zoomAt(view, size, 650, 120, zoom);
			const after = screenToBlock(next, size, 650, 120);
			expect(after.x).toBeCloseTo(before.x, 6);
			expect(after.z).toBeCloseTo(before.z, 6);
			expect(next.zoom).toBe(zoom);
		}
	});
});

describe("panBy", () => {
	test("dragging right moves the view left, scaled by zoom", () => {
		expect(panBy(view, 10, 0).centerX).toBe(90);
		expect(panBy({ ...view, zoom: -1 }, 10, 20)).toMatchObject({
			centerX: 95,
			centerZ: -60,
		});
	});
});

describe("convertView between dimensions", () => {
	const at: View = { centerX: 800, centerZ: -160, zoom: 1 };

	test("overworld to nether divides coordinates by 8 and zooms in 3 levels to keep the same area", () => {
		expect(convertView(at, 1, 8, 8)).toEqual({
			centerX: 100,
			centerZ: -20,
			zoom: -2,
		});
	});

	test("nether to overworld multiplies by 8 and zooms out", () => {
		expect(
			convertView({ centerX: 100, centerZ: -20, zoom: -2 }, 8, 1, 8),
		).toEqual(at);
	});

	test("the visible area is preserved: the same overworld block sits at the same pixel", () => {
		const size = { width: 800, height: 600 };
		const nether = convertView(at, 1, 8, 8) as View;
		// Overworld block (880, -100) is Nether block (110, -12.5).
		const a = blockToScreen(at, size, 880, -100);
		const b = blockToScreen(nether, size, 110, -12.5);
		expect(b.x).toBeCloseTo(a.x, 6);
		expect(b.y).toBeCloseTo(a.y, 6);
	});

	test("dimensions with the same scale keep the view as it is", () => {
		expect(convertView(at, 1, 1, 8)).toEqual(at);
		expect(convertView(at, 8, 8, 8)).toEqual(at);
	});

	test("a dimension without a scale has no equivalent place", () => {
		expect(convertView(at, 1, null, 8)).toBeNull();
		expect(convertView(at, null, 8, 8)).toBeNull();
		expect(convertView(at, null, null, 8)).toBeNull();
	});

	test("the zoom stays within the allowed range", () => {
		expect(convertView({ ...at, zoom: -3 }, 1, 8, 8)?.zoom).toBe(-4);
		expect(convertView({ ...at, zoom: 7 }, 8, 1, 8)?.zoom).toBe(8);
	});

	test("custom scales work (e.g. a 1:2 dimension)", () => {
		expect(convertView({ centerX: 10, centerZ: 10, zoom: 0 }, 1, 2, 8)).toEqual(
			{ centerX: 5, centerZ: 5, zoom: -1 },
		);
	});
});

describe("clampZoom / tileLevel", () => {
	test("clamps to [-4, max]", () => {
		expect(clampZoom(-10, 8)).toBe(-4);
		expect(clampZoom(20, 8)).toBe(8);
		expect(clampZoom(1.5, 8)).toBe(1.5);
	});

	test("level is the coarsest that does not magnify, clamped", () => {
		expect(tileLevel(-3, 1, 8)).toBe(0);
		expect(tileLevel(0, 1, 8)).toBe(0);
		expect(tileLevel(0.1, 1, 8)).toBe(0);
		expect(tileLevel(0.99, 1, 8)).toBe(0);
		expect(tileLevel(1, 1, 8)).toBe(1);
		expect(tileLevel(1.5, 1, 8)).toBe(1);
		expect(tileLevel(7.5, 1, 8)).toBe(7);
		expect(tileLevel(12, 1, 8)).toBe(8);
	});

	test("tile pixels are never larger than device pixels (no upscaling blur)", () => {
		for (const dpr of [1, 1.25, 1.5, 2, 3]) {
			for (let zoom = -4; zoom <= 8; zoom += 0.05) {
				const level = tileLevel(zoom, dpr, 12);
				const devicePxPerTilePx = 2 ** (level - zoom) * dpr;
				if (level > 0) expect(devicePxPerTilePx).toBeLessThanOrEqual(1 + 1e-6);
				// ...and the next coarser level would be magnified.
				if (level > 0 && level < 12)
					expect(2 ** (level + 1 - zoom) * dpr).toBeGreaterThan(1);
			}
		}
	});

	test("high dpr picks finer levels", () => {
		expect(tileLevel(1, 2, 8)).toBe(0);
		expect(tileLevel(2, 2, 8)).toBe(1);
		expect(tileLevel(2, 3, 8)).toBe(0);
		expect(tileLevel(3, 3, 8)).toBe(1);
	});
});

describe("visibleTiles", () => {
	test("negative coordinates floor toward -infinity", () => {
		const v: View = { centerX: 0, centerZ: 0, zoom: 0 };
		const r = visibleTiles(v, { width: 200, height: 100 }, 0, 64);
		expect(r).toEqual({ minX: -2, maxX: 1, minY: -1, maxY: 0 });
	});

	test("coarser levels cover more blocks per tile", () => {
		const v: View = { centerX: 0, centerZ: 0, zoom: 2 };
		const r = visibleTiles(v, { width: 800, height: 600 }, 2, 512);
		expect(r.minX).toBe(-1);
		expect(r.maxX).toBe(0);
	});

	test("tile rects tile the plane without gaps", () => {
		const v: View = { centerX: 37, centerZ: -91, zoom: 1.3 };
		const a = tileRect(v, size, 2, 512, 0, 0);
		const b = tileRect(v, size, 2, 512, 1, 0);
		expect(a.x + a.w).toBeCloseTo(b.x, 6);
	});
});

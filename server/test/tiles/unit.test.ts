import { describe, expect, test } from "bun:test";
import {
	downscaleInto,
	emptyTile,
	isEmpty,
	overRegion,
} from "../../src/tiles/compose";
import { blackToAlpha, parseXaeroCoords } from "../../src/tiles/xaero";

describe("parseXaeroCoords", () => {
	const cases: [string, { x: number; z: number } | null][] = [
		["Overworld_x0_z0.png", { x: 0, z: 0 }],
		["Overworld_x-512_z-1024.png", { x: -512, z: -1024 }],
		["x_x512_z-512_extra.png", { x: 512, z: -512 }],
		["prefix_x-1_z2", { x: -1, z: 2 }],
		["no_coords.png", null],
		["only_x5.png", null],
		["big_x99999999999_z0.png", null],
	];
	for (const [name, expected] of cases) {
		test(name, () => expect(parseXaeroCoords(name)).toEqual(expected));
	}
});

describe("blackToAlpha", () => {
	test("only pure black becomes transparent", () => {
		const px = Uint8Array.from([
			0, 0, 0, 255, 0, 0, 1, 255, 1, 0, 0, 255, 255, 255, 255, 255,
		]);
		blackToAlpha(px);
		expect([px[3], px[7], px[11], px[15]]).toEqual([0, 255, 255, 255]);
	});
});

describe("overRegion", () => {
	const rgba = (r: number, g: number, b: number, a: number, n: number) =>
		Buffer.from(Array.from({ length: n }, () => [r, g, b, a]).flat());

	test("opaque source replaces, transparent source keeps", () => {
		const dst = rgba(1, 2, 3, 255, 4); // 2x2
		overRegion(dst, 2, Buffer.from([9, 9, 9, 255, 0, 0, 0, 0]), 2, 1, 0, 0);
		expect([...dst.subarray(0, 8)]).toEqual([9, 9, 9, 255, 1, 2, 3, 255]);
	});

	test("clips regions outside the destination, including negative offsets", () => {
		const dst = emptyTile(2);
		overRegion(dst, 2, rgba(5, 5, 5, 255, 9), 3, 3, -2, -2); // only src(2,2) lands on dst(0,0)
		expect(dst[3]).toBe(255);
		expect(dst[7]).toBe(0);
		overRegion(dst, 2, rgba(7, 7, 7, 255, 4), 2, 2, 1, 1); // only src(0,0) lands on dst(1,1)
		expect(dst[15]).toBe(255);
	});

	test("semi-transparent source blends", () => {
		const dst = rgba(0, 0, 0, 255, 1);
		overRegion(dst, 1, rgba(200, 100, 0, 128, 1), 1, 1, 0, 0);
		expect(dst[0]).toBe(Math.round((200 * 128) / 255));
		expect(dst[3]).toBe(255);
	});
});

describe("downscaleInto", () => {
	test("averages 2x2 blocks into the right quadrant and ignores transparent pixels", () => {
		const T = 4;
		const child = emptyTile(T);
		for (let y = 0; y < 2; y++) {
			for (let x = 0; x < 2; x++) child.set([100, 0, 0, 255], (y * T + x) * 4);
		}
		child.set([200, 0, 0, 255], (0 * T + 2) * 4); // second block: one opaque pixel of four
		const parent = emptyTile(T);
		downscaleInto(parent, child, T, 1, 1);
		expect([...parent.subarray((2 * T + 2) * 4, (2 * T + 2) * 4 + 4)]).toEqual([
			100, 0, 0, 255,
		]);
		expect([...parent.subarray((2 * T + 3) * 4, (2 * T + 3) * 4 + 4)]).toEqual([
			200, 0, 0, 64,
		]);
		expect(isEmpty(parent.subarray(0, 2 * T * 4))).toBe(true);
	});
});

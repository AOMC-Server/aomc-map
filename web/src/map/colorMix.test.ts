import { describe, expect, test } from "bun:test";
import { hexToRgb, mixColors, rgbToHex, textOn } from "./colorMix";

describe("colour mixing", () => {
	test("hex and rgb convert both ways", () => {
		expect(hexToRgb("#e1372e")).toEqual([225, 55, 46]);
		expect(rgbToHex([225, 55, 46])).toBe("#e1372e");
	});

	test("one colour mixes to itself", () => {
		const mixed = mixColors([{ data: [225, 55, 46], count: 4 }]);
		expect(rgbToHex(mixed)).toBe("#e1372e");
	});

	test("the mix leans towards the colour with more pins", () => {
		const red = hexToRgb("#e1372e");
		const blue = hexToRgb("#4952cc");
		const [r1, , b1] = mixColors([
			{ data: red, count: 5 },
			{ data: blue, count: 1 },
		]);
		const [r2, , b2] = mixColors([
			{ data: red, count: 1 },
			{ data: blue, count: 5 },
		]);
		expect(r1).toBeGreaterThan(r2);
		expect(b1).toBeLessThan(b2);
	});

	test("text is dark on light fills and white on dark ones", () => {
		expect(textOn(hexToRgb("#fed83d"))).toBe("#1d1d21");
		expect(textOn(hexToRgb("#eeeeee"))).toBe("#1d1d21");
		expect(textOn(hexToRgb("#4952cc"))).toBe("#fff");
		expect(textOn(hexToRgb("#1d1d21"))).toBe("#fff");
	});
});

import { describe, expect, test } from "bun:test";
import { describeDimensionScale, formatScale, parseScale } from "./scale";

describe("parseScale", () => {
	test("numbers", () => {
		expect(parseScale("8")).toBe(8);
		expect(parseScale(" 0.5 ")).toBe(0.5);
		expect(parseScale("1")).toBe(1);
	});
	test("empty or 'none' means no relevant scale", () => {
		for (const t of ["", "  ", "none", "None", "-", "n/a"])
			expect(parseScale(t)).toBeNull();
	});
	test("anything else is invalid", () => {
		for (const t of ["abc", "0", "-3", "1e3", "8x", "1,5", "9999999"])
			expect(parseScale(t)).toBeUndefined();
	});
});

describe("formatting", () => {
	test("round trip", () => {
		expect(formatScale(8)).toBe("8");
		expect(formatScale(null)).toBe("");
		expect(parseScale(formatScale(0.25))).toBe(0.25);
	});
	test("descriptions", () => {
		expect(describeDimensionScale(null)).toContain("can't be compared");
		expect(describeDimensionScale(1)).toContain("overworld");
		expect(describeDimensionScale(8)).toBe("1 block here = 8 overworld blocks");
	});
});

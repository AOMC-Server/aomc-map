import { describe, expect, test } from "bun:test";
import { formatUrl, parseUrl } from "./url";

describe("url state", () => {
	test("parses everything", () => {
		expect(
			parseUrl("?map=aomc&dim=nether&x=-12&z=340&zoom=1.5&rev=7&embed=1"),
		).toEqual({
			map: "aomc",
			dim: "nether",
			view: { centerX: -12, centerZ: 340, zoom: 1.5 },
			rev: 7,
			embed: true,
		});
	});

	test("empty URL means defaults", () => {
		expect(parseUrl("")).toEqual({
			map: null,
			dim: null,
			view: { centerX: undefined, centerZ: undefined, zoom: undefined },
			rev: null,
			embed: false,
		});
	});

	test("ignores garbage numbers and negative or fractional revs", () => {
		const s = parseUrl("?x=abc&z=&zoom=Infinity&rev=-1");
		expect(s.view).toEqual({
			centerX: undefined,
			centerZ: undefined,
			zoom: undefined,
		});
		expect(s.rev).toBeNull();
		expect(parseUrl("?rev=1.5").rev).toBeNull();
	});

	test("format omits rev at head and embed when off, and round trips", () => {
		const state = {
			map: "aomc",
			dim: "overworld",
			view: { centerX: 10.4, centerZ: -3.6, zoom: 2.456 },
			rev: null,
			embed: false,
		};
		const url = formatUrl(state);
		expect(url).toBe("?map=aomc&dim=overworld&x=10&z=-4&zoom=2.46");
		expect(parseUrl(url).view).toEqual({
			centerX: 10,
			centerZ: -4,
			zoom: 2.46,
		});
		expect(formatUrl({ ...state, rev: 3, embed: true })).toContain(
			"rev=3&embed=1",
		);
	});
});

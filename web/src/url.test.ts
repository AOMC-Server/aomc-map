import { describe, expect, test } from "bun:test";
import { formatUrl, parseUrl } from "./url";

describe("url state", () => {
	test("parses everything", () => {
		expect(parseUrl("?dim=nether&x=-12&z=340&zoom=1.5&rev=7&embed=1")).toEqual({
			dim: "nether",
			view: { centerX: -12, centerZ: 340, zoom: 1.5 },
			rev: 7,
			embed: true,
			layers: null,
		});
	});

	test("empty URL means defaults", () => {
		expect(parseUrl("")).toEqual({
			dim: null,
			view: { centerX: undefined, centerZ: undefined, zoom: undefined },
			rev: null,
			embed: false,
			layers: null,
		});
	});

	test("parses the layers of a shared view", () => {
		expect(parseUrl("?layers=3,1,x,-2,1.5,7").layers).toEqual([3, 1, 7]);
		// Listed but empty: no layer is shown, which differs from not listed.
		expect(parseUrl("?layers=").layers).toEqual([]);
	});

	test("ignores the old map parameter", () => {
		expect(parseUrl("?map=aomc&dim=nether")).not.toHaveProperty("map");
		expect(
			formatUrl({
				dim: "nether",
				view: { centerX: 0, centerZ: 0, zoom: 1 },
				rev: null,
				embed: false,
			}),
		).not.toContain("map");
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
			dim: "overworld",
			view: { centerX: 10.4, centerZ: -3.6, zoom: 2.456 },
			rev: null,
			embed: false,
		};
		const url = formatUrl(state);
		expect(url).toBe("?dim=overworld&x=10&z=-4&zoom=2.46");
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

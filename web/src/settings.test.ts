import { describe, expect, test } from "bun:test";
import {
	clampPanelWidth,
	DEFAULT_SETTINGS,
	mapOutlineScales,
	PANEL_MIN_WIDTH,
	parsePosition,
	parseSettings,
	transitionFactor,
} from "./settings";

describe("parseSettings", () => {
	test("nothing or garbage gives the defaults", () => {
		expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings("42")).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
	});

	test("valid values are kept, missing ones default", () => {
		const s = parseSettings(
			JSON.stringify({ showScale: false, defaultDimension: "nether" }),
		);
		expect(s).toEqual({
			...DEFAULT_SETTINGS,
			showScale: false,
			defaultDimension: "nether",
		});
	});

	test("values of the wrong type are ignored", () => {
		const s = parseSettings(
			JSON.stringify({
				showCoordinates: "no",
				rememberPosition: 1,
				defaultDimension: 7,
			}),
		);
		expect(s).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings(JSON.stringify({ defaultDimension: "" }))).toEqual(
			DEFAULT_SETTINGS,
		);
	});

	test("keeps a known mode and style and drops unknown ones", () => {
		const s = parseSettings(
			JSON.stringify({ mode: "light", style: "xp", dimensionColours: false }),
		);
		expect(s).toEqual({
			...DEFAULT_SETTINGS,
			mode: "light",
			style: "xp",
			dimensionColours: false,
		});
		expect(
			parseSettings(JSON.stringify({ mode: "dim", style: "vista" })),
		).toEqual(DEFAULT_SETTINGS);
	});
});

test("debug toggles default off and are kept when stored", () => {
	expect(DEFAULT_SETTINGS.debugRender).toBe(false);
	expect(DEFAULT_SETTINGS.tileOutlines).toBe(false);
	expect(DEFAULT_SETTINGS.chunkOutlines).toBe(false);
	expect(DEFAULT_SETTINGS.regionOutlines).toBe(false);
	expect(DEFAULT_SETTINGS.mapOutlines).toBe("off");
	const s = parseSettings(
		JSON.stringify({
			debugRender: true,
			tileOutlines: true,
			chunkOutlines: 1,
			regionOutlines: true,
			mapOutlines: "2",
		}),
	);
	expect(s.debugRender).toBe(true);
	expect(s.tileOutlines).toBe(true);
	expect(s.chunkOutlines).toBe(false);
	expect(s.regionOutlines).toBe(true);
	expect(s.mapOutlines).toBe("2");
});

test("map outlines keep a known choice and turn into scales", () => {
	for (const bad of [true, 2, "5", "none"])
		expect(
			parseSettings(JSON.stringify({ mapOutlines: bad })).mapOutlines,
		).toBe("off");
	expect(mapOutlineScales("off")).toEqual([]);
	expect(mapOutlineScales("3")).toEqual([3]);
	expect(mapOutlineScales("all")).toEqual([0, 1, 2, 3, 4]);
});

describe("parsePosition", () => {
	test("reads a saved position", () => {
		const p = { dim: "nether", view: { centerX: 1, centerZ: -2, zoom: 0.5 } };
		expect(parsePosition(JSON.stringify(p))).toEqual(p);
	});

	test("rejects anything incomplete", () => {
		expect(parsePosition(null)).toBeNull();
		expect(parsePosition("nope")).toBeNull();
		expect(parsePosition(JSON.stringify({ dim: "x" }))).toBeNull();
		expect(
			parsePosition(
				JSON.stringify({ dim: "x", view: { centerX: 1, centerZ: 2 } }),
			),
		).toBeNull();
	});
});

describe("panel width", () => {
	test("is kept between the minimum and most of the window", () => {
		expect(clampPanelWidth(100, 1400)).toBe(PANEL_MIN_WIDTH);
		expect(clampPanelWidth(500, 1400)).toBe(500);
		expect(clampPanelWidth(5000, 1400)).toBe(900);
		expect(clampPanelWidth(5000, 1000)).toBe(700);
		// A narrow window still gets the minimum.
		expect(clampPanelWidth(500, 340)).toBe(PANEL_MIN_WIDTH);
	});
});

describe("transition speed", () => {
	test("a known speed is kept, anything else falls back to normal", () => {
		expect(
			parseSettings(JSON.stringify({ transitionSpeed: "fast" }))
				.transitionSpeed,
		).toBe("fast");
		for (const bad of ["warp", 3, null])
			expect(
				parseSettings(JSON.stringify({ transitionSpeed: bad })).transitionSpeed,
			).toBe("normal");
	});

	test("the factors scale durations, and instant is zero", () => {
		expect(transitionFactor("normal")).toBe(1);
		expect(transitionFactor("slow")).toBeGreaterThan(1);
		expect(transitionFactor("fast")).toBeLessThan(1);
		expect(transitionFactor("instant")).toBe(0);
	});
});

test("the pin cluster distance is kept within its range", () => {
	expect(DEFAULT_SETTINGS.pinClusterDistance).toBe(56);
	const parse = (v: unknown) =>
		parseSettings(JSON.stringify({ pinClusterDistance: v })).pinClusterDistance;
	expect(parse(30.4)).toBe(30);
	expect(parse(1)).toBe(8);
	expect(parse(9999)).toBe(120);
	for (const bad of ["40", null, true, {}])
		expect(parse(bad)).toBe(DEFAULT_SETTINGS.pinClusterDistance);
});

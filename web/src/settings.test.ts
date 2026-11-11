import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, parsePosition, parseSettings } from "./settings";

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

import { describe, expect, test } from "bun:test";
import { featureMatches, searchLayers } from "./layerSearch";
import type { FeatureData, LayerData } from "./state";

const feature = (
	id: number,
	name: string,
	type: FeatureData["type"] = "pin",
	popup = "",
) => ({ id, name, type, popup }) as FeatureData;

const layer = (id: number, name: string, features: FeatureData[]) =>
	({ id, name, features }) as LayerData;

describe("featureMatches", () => {
	test("looks in the name, the popup text and the type, ignoring case", () => {
		const f = feature(1, "Spawn Farm", "line", "Iron golem **trap**");
		expect(featureMatches(f, "spawn")).toBe(true);
		expect(featureMatches(f, "GOLEM")).toBe(true);
		expect(featureMatches(f, "line")).toBe(true);
		expect(featureMatches(f, "nether")).toBe(false);
	});

	test("an empty query matches everything", () => {
		expect(featureMatches(feature(1, "x"), "")).toBe(true);
		expect(featureMatches(feature(1, "x"), "   ")).toBe(true);
	});
});

describe("searchLayers", () => {
	const layers = [
		layer(1, "Bases", [feature(1, "North base"), feature(2, "South farm")]),
		layer(2, "Roads", [feature(3, "Main road", "line")]),
		layer(3, "Empty", []),
	];

	test("without a query every layer is listed whole, even empty ones", () => {
		const out = searchLayers(layers, "");
		expect(out.map((m) => m.layer.id)).toEqual([1, 2, 3]);
		expect(out[0]?.features).toHaveLength(2);
	});

	test("only layers with matching features are listed, with just those features", () => {
		const out = searchLayers(layers, "farm");
		expect(out.map((m) => m.layer.id)).toEqual([1]);
		expect(out[0]?.features.map((f) => f.id)).toEqual([2]);
	});

	test("a matching layer name lists the whole layer", () => {
		const out = searchLayers(layers, "roads");
		expect(out).toHaveLength(1);
		expect(out[0]?.features.map((f) => f.id)).toEqual([3]);
		expect(searchLayers(layers, "empty")[0]?.features).toEqual([]);
	});

	test("nothing matching gives an empty list", () => {
		expect(searchLayers(layers, "zzz")).toEqual([]);
	});
});

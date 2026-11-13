import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DYE_HEX } from "@aomc/shared/colors";
import type { MapView } from "../map/MapView";
import { activeTool, hoverInfo } from "../state";
import { initFeatureInteraction } from "./features";

type Handler = (e: never) => void;
const handlers = new Map<string, Handler>();
const map = {
	on: (name: string, cb: Handler) => handlers.set(name, cb),
	setSelectedFeature() {},
} as unknown as MapView;
const hover = (hit: unknown) =>
	(handlers.get("hover") as Handler)({ hit, sx: 10, sy: 20 } as never);

const feature = (name: string, color: string | null) => ({
	kind: "feature",
	feature: { id: 1, layerId: 1, type: "pin", name, color, geometry: [0, 0] },
	layer: { id: 1, color: "red", features: [] },
});

beforeAll(() => initFeatureInteraction(map));
beforeEach(() => {
	hoverInfo.value = null;
	activeTool.value = "none";
});

describe("the hover tooltip", () => {
	test("takes the colour of the feature, or else of its layer", () => {
		hover(feature("Base", "lime"));
		expect(hoverInfo.value).toEqual({
			text: "Base",
			sx: 10,
			sy: 20,
			color: DYE_HEX.lime,
		});
		hover(feature("Base", null));
		expect(hoverInfo.value?.color).toBe(DYE_HEX.red);
	});

	test("a cluster of pins is tinted by the mix of their colours", () => {
		hover({ kind: "cluster", count: 3, bounds: {}, color: "#804020" });
		expect(hoverInfo.value?.text).toBe("3 pins");
		expect(hoverInfo.value?.color).toBe("#804020");
	});

	test("a feature without a name shows nothing", () => {
		hover(feature("  ", "lime"));
		expect(hoverInfo.value).toBeNull();
	});

	test("nothing shows while a tool is in use", () => {
		activeTool.value = "measure";
		hover(feature("Base", "lime"));
		expect(hoverInfo.value).toBeNull();
	});
});

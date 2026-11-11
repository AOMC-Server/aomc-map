import { describe, expect, test } from "bun:test";
import type { View } from "@aomc/shared/view";
import { FeatureLayer, type RenderLayer } from "./featureLayer";

const size = { width: 1000, height: 700 };
const view: View = { centerX: 0, centerZ: 250, zoom: 0 };

const layer: RenderLayer = {
	id: 1,
	color: "red",
	features: [
		{
			id: 1,
			layerId: 1,
			type: "line",
			name: "Road",
			popup: "",
			color: null,
			geometry: [
				[-300, 100],
				[-200, 180],
				[-100, 150],
				[100, 300],
			],
		},
		{
			id: 2,
			layerId: 1,
			type: "polygon",
			name: "Town",
			popup: "",
			color: "purple",
			geometry: [
				[150, 100],
				[300, 120],
				[320, 230],
				[180, 260],
			],
		},
	],
};

function makeLayer() {
	const l = new FeatureLayer(() => {});
	l.setFeatures([layer]);
	return l;
}

const name = (hit: ReturnType<FeatureLayer["hitTest"]>) =>
	hit?.kind === "feature" ? hit.feature.name : hit;

describe("FeatureLayer.hitTest", () => {
	test("lines are hit within a few pixels, and not further away", () => {
		const l = makeLayer();
		// Block (-250, 140) is the middle of the first segment; screen = block - centre + half size.
		expect(name(l.hitTest(view, size, 250 + 0.5, 240 + 0.5))).toBe("Road");
		expect(name(l.hitTest(view, size, 250, 245))).toBe("Road");
		expect(l.hitTest(view, size, 250, 270)).toBeNull();
	});

	test("polygons are hit inside and on their edge", () => {
		const l = makeLayer();
		expect(name(l.hitTest(view, size, 740, 280))).toBe("Town");
		expect(name(l.hitTest(view, size, 651, 200))).toBe("Town");
		expect(l.hitTest(view, size, 900, 600)).toBeNull();
	});

	test("tolerance is in screen pixels, so zooming out widens it in blocks", () => {
		const l = makeLayer();
		const far: View = { centerX: 0, centerZ: 250, zoom: 3 };
		// At zoom 3 one pixel is 8 blocks; the first segment's midpoint is at screen (500-250/8, 350-110/8).
		const x = 500 - 250 / 8;
		const y = 350 - 110 / 8;
		expect(name(l.hitTest(far, size, x, y + 5))).toBe("Road");
	});
});

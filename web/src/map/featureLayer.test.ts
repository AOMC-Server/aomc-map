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

	test("every path of a branching line is hit", () => {
		const l = new FeatureLayer(() => {});
		l.setFeatures([
			{
				id: 1,
				color: "red",
				features: [
					{
						id: 3,
						layerId: 1,
						type: "line",
						name: "Junction",
						popup: "",
						color: null,
						geometry: [
							[
								[-100, 0],
								[100, 0],
							],
							[
								[0, 0],
								[0, 100],
							],
						],
					},
				],
			},
		]);
		const v: View = { centerX: 0, centerZ: 0, zoom: 0 };
		expect(name(l.hitTest(v, size, 450.5, 350.5))).toBe("Junction");
		expect(name(l.hitTest(v, size, 500.5, 400.5))).toBe("Junction");
		expect(l.hitTest(v, size, 450.5, 400.5)).toBeNull();
	});
});

describe("FeatureLayer hit order", () => {
	const feature = (
		id: number,
		type: "line" | "polygon",
		geometry: [number, number][],
	) => ({
		id,
		layerId: 1,
		type,
		name: `f${id}`,
		popup: "",
		color: null,
		geometry,
	});

	test("a line wins over a polygon edge it shares a pixel with, whatever their order", () => {
		const l = new FeatureLayer(() => {});
		l.setFeatures([
			{
				id: 1,
				color: "red",
				features: [
					feature(1, "line", [
						[-50, 0],
						[50, 0],
					]),
					// Added after the line, but drawn below it.
					feature(2, "polygon", [
						[-50, 0],
						[50, 0],
						[50, 100],
						[-50, 100],
					]),
				],
			},
		]);
		const v: View = { centerX: 0, centerZ: 0, zoom: 0 };
		expect(name(l.hitTest(v, size, 500.5, 350.5 + 2))).toBe("f1");
	});

	test("the smaller polygon on top is hit inside, the bigger one on its edge", () => {
		const l = new FeatureLayer(() => {});
		const square = (id: number, min: number, max: number) =>
			feature(id, "polygon", [
				[min, min],
				[max, min],
				[max, max],
				[min, max],
			]);
		l.setFeatures([
			{
				id: 1,
				color: "red",
				features: [square(1, -100, 100), square(2, -20, 20)],
			},
		]);
		const v: View = { centerX: 0, centerZ: 0, zoom: 0 };
		expect(name(l.hitTest(v, size, 500.5, 350.5))).toBe("f2");
		expect(name(l.hitTest(v, size, 500.5 - 100, 350.5))).toBe("f1");
	});
});

describe("FeatureLayer.draw", () => {
	test("a cluster present in both crossfaded levels is drawn and hit-tested once", () => {
		const l = new FeatureLayer(() => {});
		l.setFeatures([
			{
				id: 1,
				color: "red",
				features: [
					{ x: 0, z: 0 },
					{ x: 1, z: 0 },
				].map(({ x, z }, i) => ({
					id: i + 1,
					layerId: 1,
					type: "pin" as const,
					name: `p${i}`,
					popup: "",
					color: null,
					geometry: [x, z],
				})),
			},
		]);
		let labels = 0;
		const ctx = new Proxy(
			{},
			{
				get: (_t, prop) =>
					prop === "fillText"
						? () => labels++
						: prop === "measureText"
							? () => ({ width: 0 })
							: () => {},
				set: () => true,
			},
		) as unknown as CanvasRenderingContext2D;
		// Zoom 0.25 sits in the middle of a crossfade between two cluster levels.
		const v: View = { centerX: 0, centerZ: 0, zoom: 0.25 };
		l.draw(ctx, v, size);
		expect(labels).toBe(1);
		const hit = l.hitTest(v, size, 500.5, 350.5);
		expect(hit?.kind).toBe("cluster");
	});
});

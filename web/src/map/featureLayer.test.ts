import { describe, expect, test } from "bun:test";
import type { View } from "@aomc/shared/view";
import { FeatureLayer, type RenderLayer } from "./featureLayer";
import { distToPolyline, type Pt } from "./geometry";
import { smoothShape } from "./smooth";

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

describe("FeatureLayer styles", () => {
	const v: View = { centerX: 0, centerZ: 0, zoom: 0 };
	const line = (id: number, style: object | null) => ({
		id,
		layerId: 1,
		type: "line" as const,
		name: `line${id}`,
		popup: "",
		color: null,
		style,
		geometry: [
			[-100, 0],
			[100, 0],
		],
	});
	const area = (style: object | null) => ({
		id: 9,
		layerId: 1,
		type: "polygon" as const,
		name: "Area",
		popup: "",
		color: null,
		style,
		geometry: [
			[-100, -100],
			[100, -100],
			[100, 100],
			[-100, 100],
		],
	});
	const layerOf = (
		...features: ReturnType<typeof line>[] | ReturnType<typeof area>[]
	) => ({ id: 1, color: "red", features }) as RenderLayer;

	test("a thick line is hit from further away", () => {
		const thin = new FeatureLayer(() => {});
		thin.setFeatures([layerOf(line(1, null))]);
		const thick = new FeatureLayer(() => {});
		thick.setFeatures([layerOf(line(1, { width: 10 }))]);
		// Eight pixels off the line: outside the default tolerance (7), inside a 10 px line's (9).
		expect(thin.hitTest(v, size, 500.5, 350.5 + 8)).toBeNull();
		expect(name(thick.hitTest(v, size, 500.5, 350.5 + 8))).toBe("line1");
	});

	test("an area without a fill is only hit on its edge", () => {
		const filled = new FeatureLayer(() => {});
		filled.setFeatures([layerOf(area(null))]);
		const hollow = new FeatureLayer(() => {});
		hollow.setFeatures([layerOf(area({ fill: "none" }))]);
		expect(name(filled.hitTest(v, size, 500, 350))).toBe("Area");
		expect(hollow.hitTest(v, size, 500, 350)).toBeNull();
		expect(name(hollow.hitTest(v, size, 600.5, 350.5))).toBe("Area");
		// A pattern is a fill.
		const striped = new FeatureLayer(() => {});
		striped.setFeatures([layerOf(area({ fill: "stripes" }))]);
		expect(name(striped.hitTest(v, size, 500, 350))).toBe("Area");
	});

	test("the layer's default style applies to its features", () => {
		const l = new FeatureLayer(() => {});
		l.setFeatures([
			{
				id: 1,
				color: "red",
				style: { width: 10, fill: "none" },
				features: [line(1, null), area(null)],
			} as RenderLayer,
		]);
		// The layer makes lines thick, so a point 8 px off still hits; its areas are hollow.
		expect(name(l.hitTest(v, size, 500.5, 350.5 + 8))).toBe("line1");
		expect(l.hitTest(v, size, 500, 400)).toBeNull();
		// A feature of its own wins over the layer.
		const own = new FeatureLayer(() => {});
		own.setFeatures([
			{
				id: 1,
				color: "red",
				style: { width: 10 },
				features: [line(1, { width: 1 })],
			} as RenderLayer,
		]);
		expect(own.hitTest(v, size, 500.5, 350.5 + 8)).toBeNull();
	});

	test("a smoothed line is hit along its curve, not along its straight segments", () => {
		const geometry = [
			[-400, 0],
			[0, 0],
			[0, 400],
			[400, 400],
		];
		const bend = {
			id: 5,
			layerId: 1,
			type: "line" as const,
			name: "Bend",
			popup: "",
			color: null,
			style: null as object | null,
			geometry,
		};
		const straight = new FeatureLayer(() => {});
		straight.setFeatures([layerOf(bend)]);
		const curvy = new FeatureLayer(() => {});
		curvy.setFeatures([layerOf({ ...bend, style: { smooth: true } })]);
		// Both go through every point.
		for (const l of [straight, curvy]) {
			expect(name(l.hitTest(v, size, 500.5, 350.5))).toBe("Bend");
			expect(name(l.hitTest(v, size, 500.5, 750.5))).toBe("Bend");
		}
		// The point of the curve that is furthest from the straight segments.
		const samples = smoothShape("line", [
			geometry as unknown as Pt[],
		]).strokes.flatMap((st) => st.samples);
		const off = (p: Pt) =>
			distToPolyline(p[0], p[1], geometry as unknown as Pt[], false);
		const far = samples.reduce((best, p) => (off(p) > off(best) ? p : best));
		expect(off(far)).toBeGreaterThan(10);
		const sx = 500.5 + far[0];
		const sy = 350.5 + far[1];
		expect(name(curvy.hitTest(v, size, sx, sy))).toBe("Bend");
		expect(straight.hitTest(v, size, sx, sy)).toBeNull();
	});

	test("a smoothed area is hit inside its curve", () => {
		const l = new FeatureLayer(() => {});
		l.setFeatures([layerOf(area({ smooth: true }))]);
		expect(name(l.hitTest(v, size, 500, 350))).toBe("Area");
		expect(l.hitTest(v, size, 900, 700)).toBeNull();
	});

	test("a draft takes the place of the feature it replaces, or is added, and is never under the pointer", () => {
		const l = new FeatureLayer(() => {});
		l.setFeatures([layerOf(line(1, null))]);
		const layer = { id: 1, color: "red" as const };
		l.setDraft(
			layer,
			{
				...line(-1, null),
				name: "draft",
				geometry: [
					[-100, 80],
					[100, 80],
				],
			},
			1,
		);
		// The saved feature is gone from the map while its draft is shown. The draft itself is only
		// drawn: if the pointer could hit it, it would be drawn as hovered, and thicker, on and off.
		expect(name(l.hitTest(v, size, 500.5, 350.5))).toBeNull();
		expect(name(l.hitTest(v, size, 500.5, 350.5 + 80))).toBeNull();
		l.setDraft(layer, null, null);
		expect(name(l.hitTest(v, size, 500.5, 350.5))).toBe("line1");
		l.setDraft(
			layer,
			{
				...line(-1, null),
				name: "draft",
				geometry: [
					[-100, 80],
					[100, 80],
				],
			},
			null,
		);
		expect(name(l.hitTest(v, size, 500.5, 350.5))).toBe("line1");
		expect(name(l.hitTest(v, size, 500.5, 350.5 + 80))).toBeNull();
	});
});

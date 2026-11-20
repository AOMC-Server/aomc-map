import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { buildOverlay, type OverlayLayer } from "../src/previewFeatures";
import { bootTiles, call, cleanupTempDirs, type TileApp } from "./helpers";

afterAll(cleanupTempDirs);

const SIZE = { width: 1200, height: 630 };
const VIEW = { centerX: 0.5, centerZ: 0.5, zoom: 0 };
const BACKGROUND = [27, 29, 34, 255];

const layer = (features: OverlayLayer["features"]): OverlayLayer => ({
	color: "blue",
	style: null,
	features,
});

const line = (geometry: unknown, style: object | null = null) => ({
	id: 1,
	type: "line" as const,
	color: null,
	style,
	geometry,
});

describe("buildOverlay", () => {
	test("nothing to draw is null, and so is everything off screen", () => {
		expect(buildOverlay([], VIEW, SIZE)).toBeNull();
		expect(
			buildOverlay(
				[
					layer([
						line([
							[5000, 5000],
							[5100, 5000],
						]),
					]),
				],
				VIEW,
				SIZE,
			),
		).toBeNull();
	});

	test("a line is a black outline under a coloured stroke, with the style applied", () => {
		const svg = buildOverlay(
			[
				layer([
					line(
						[
							[-10, 0],
							[10, 0],
						],
						{ dash: "dashed", width: 5, opacity: 0.5 },
					),
				]),
			],
			VIEW,
			SIZE,
		) as string;
		expect(svg).toContain('stroke="#4952cc"');
		expect(svg).toContain('stroke-width="5"');
		expect(svg).toContain('stroke-width="7"');
		expect(svg).toContain("stroke-dasharray");
		expect(svg).toContain('stroke-opacity="0.5"');
	});

	test("areas fill with patterns, and none leaves them open", () => {
		const square = [
			[0, 0],
			[50, 0],
			[50, 50],
			[0, 50],
		];
		const area = (fill: string) =>
			buildOverlay(
				[
					layer([
						{
							id: 1,
							type: "polygon",
							color: "red",
							style: { fill },
							geometry: square,
						} as never,
					]),
				],
				VIEW,
				SIZE,
			) as string;
		expect(area("stripes")).toContain('<pattern id="stripes-e1372e"');
		expect(area("stripes")).toContain('fill="url(#stripes-e1372e)"');
		expect(area("crosshatch")).toContain('<pattern id="crosshatch-e1372e"');
		expect(area("dots")).toContain("<circle");
		expect(area("solid")).toContain('fill="#e1372e"');
		expect(area("none")).not.toContain("fill-opacity");
	});

	test("far away coordinates are cut off, so the numbers stay small", () => {
		const svg = buildOverlay(
			[
				layer([
					line([
						[-30_000_000, 0],
						[30_000_000, 0],
					]),
				]),
			],
			{ ...VIEW, zoom: -8 },
			SIZE,
		) as string;
		for (const n of svg.match(/-?\d+(\.\d+)?/g) ?? [])
			expect(Math.abs(Number(n))).toBeLessThan(10_000);
		expect(svg).toContain("<path");
	});

	test("smoothing turns corners into curves; a straight line stays a few points", () => {
		const corner = [
			[0, 0],
			[100, 0],
			[100, 100],
		];
		const count = (style: object | null) =>
			(
				(
					buildOverlay([layer([line(corner, style)])], VIEW, SIZE) as string
				).match(/L/g) ?? []
			).length;
		expect(count({ smooth: true })).toBeGreaterThan(count(null) * 5);
	});

	test("pins use the icon when there is one, a dot when not", () => {
		const pin = {
			id: 1,
			type: "pin" as const,
			color: "green",
			style: null,
			geometry: [0, 0],
		};
		const withIcon = buildOverlay(
			[layer([pin])],
			VIEW,
			SIZE,
			() => "data:image/png;base64,AAAA",
		) as string;
		expect(withIcon).toContain("<image");
		expect(buildOverlay([layer([pin])], VIEW, SIZE)).toContain("<circle");
	});

	test("a pin cut off by the edge is still drawn, one well outside is not", () => {
		const pinAt = (x: number) => ({
			id: 1,
			type: "pin" as const,
			color: null,
			style: null,
			geometry: [x, 0],
		});
		expect(buildOverlay([layer([pinAt(-600)])], VIEW, SIZE)).not.toBeNull();
		expect(buildOverlay([layer([pinAt(-700)])], VIEW, SIZE)).toBeNull();
	});
});

const decode = async (res: Response) => {
	const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return (x: number, y: number) => [
		...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
	];
};

const cacheFiles = (t: TileApp) =>
	readdirSync(join(t.env.DATA_DIR, "preview-cache")).filter((f) =>
		f.endsWith(".png"),
	);

async function layerWith(t: TileApp, body: object, feature: object) {
	const made = await call(t, t.editor, "POST", "/api/layers", {
		dimension: "overworld",
		name: "L",
		color: "blue",
		...body,
	});
	expect(made.status).toBe(201);
	const id = made.body.layer.id as number;
	const added = await call(
		t,
		t.editor,
		"POST",
		`/api/layers/${id}/features`,
		feature,
	);
	expect(added.status).toBe(201);
	return { id, featureId: added.body.feature.id as number };
}

const LINE = {
	type: "line",
	name: "Road",
	geometry: [
		[-200, 0],
		[200, 0],
	],
};
/** One pixel per block, centred on block (0, 0), so the line runs through y = 315, from x = 400 to 800. */
const URL = "/api/preview.png?x=0&z=0&zoom=0";

describe("features in /api/preview.png", () => {
	test("lines, areas and pins of public layers are drawn over the map", async () => {
		const t = await bootTiles();
		await layerWith(t, {}, LINE);
		await layerWith(
			t,
			{ color: "red" },
			{
				type: "polygon",
				name: "Field",
				geometry: [
					[100, 100],
					[300, 100],
					[300, 200],
					[100, 200],
				],
			},
		);
		await layerWith(
			t,
			{ color: "green" },
			{ type: "pin", name: "Home", geometry: [-300, -100] },
		);
		const at = await decode(await t.app.request(URL));
		expect(at(450, 315)).toEqual([73, 82, 204, 255]);
		expect(at(450, 200)).toEqual(BACKGROUND);
		// An area is a thin fill of its colour, so it tints the background.
		expect(at(800, 465)).not.toEqual(BACKGROUND);
		// The pin stands on its block (300, 215 on screen), 24 pixels tall.
		const pin = [at(300, 205), at(300, 210), at(300, 195)];
		expect(pin.some((p) => p.join() !== BACKGROUND.join())).toBe(true);
	});

	test("the layers parameter picks layers; hidden ones show only when asked for", async () => {
		const t = await bootTiles();
		const shown = await layerWith(t, {}, LINE);
		const hidden = await layerWith(t, { hiddenByDefault: true }, LINE);
		const none = await decode(await t.app.request(`${URL}&layers=`));
		expect(none(450, 315)).toEqual(BACKGROUND);
		const defaults = await decode(await t.app.request(URL));
		expect(defaults(450, 315)).toEqual([73, 82, 204, 255]);
		const onlyHidden = await decode(
			await t.app.request(`${URL}&layers=${hidden.id}`),
		);
		expect(onlyHidden(450, 315)).toEqual([73, 82, 204, 255]);
		const bogus = await decode(
			await t.app.request(`${URL}&layers=${shown.id + 99}`),
		);
		expect(bogus(450, 315)).toEqual(BACKGROUND);
	});

	test("private layers are never drawn, even when asked for", async () => {
		const t = await bootTiles();
		const secret = await layerWith(t, { visibility: "private" }, LINE);
		const at = await decode(await t.app.request(`${URL}&layers=${secret.id}`));
		expect(at(450, 315)).toEqual(BACKGROUND);
	});

	test("an edited feature gets a new picture instead of the cached one", async () => {
		const t = await bootTiles();
		const made = await layerWith(t, {}, LINE);
		await t.app.request(URL);
		expect(cacheFiles(t)).toHaveLength(1);
		const patched = await call(
			t,
			t.editor,
			"PATCH",
			`/api/features/${made.featureId}`,
			{ color: "red" },
		);
		expect(patched.status).toBe(200);
		const at = await decode(await t.app.request(URL));
		expect(at(450, 315)).toEqual([225, 55, 46, 255]);
		expect(cacheFiles(t)).toHaveLength(2);
		// The same picture again is served from the cache.
		await t.app.request(URL);
		expect(cacheFiles(t)).toHaveLength(2);
	});

	test("without features nothing changes: one cached picture, no overlay", async () => {
		const t = await bootTiles();
		const at = await decode(await t.app.request(URL));
		expect(at(450, 315)).toEqual(BACKGROUND);
		expect(cacheFiles(t)).toHaveLength(1);
	});
});

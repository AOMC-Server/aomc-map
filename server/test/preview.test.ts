import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { pruneCache } from "../src/preview";
import { BLUE, bootTiles, RED, solid, T, upload } from "./helpers";

type Booted = Awaited<ReturnType<typeof bootTiles>>;

const decode = async (res: Response) => {
	const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const at = (x: number, y: number) => [
		...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
	];
	return { info, at };
};

const cacheFiles = (t: Booted) => {
	try {
		return readdirSync(join(t.env.DATA_DIR, "preview-cache")).filter((f) =>
			f.endsWith(".png"),
		);
	} catch {
		return [];
	}
};

const BACKGROUND = [27, 29, 34, 255];

async function withTiles() {
	const t = await bootTiles();
	await upload(t, await solid(T, T, RED), 0, 0); // rev 1: blocks 0..15
	await upload(t, await solid(T, T, BLUE), T, 0); // rev 2: blocks 16..31
	return t;
}

describe("/api/preview.png", () => {
	test("is a 1200x630 PNG of the tiles around the point, with a marker in the middle", async () => {
		const t = await withTiles();
		// 4 px per block: the red tile is at screen x 534..598, the blue one at 598..662.
		const res = await t.app.request("/api/preview.png?x=16&z=8&zoom=-2");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		const { info, at } = await decode(res);
		expect(info).toMatchObject({ width: 1200, height: 630 });

		expect(at(540, 315)).toEqual([255, 0, 0, 255]);
		expect(at(655, 315)).toEqual([0, 0, 255, 255]);
		expect(at(100, 100)).toEqual(BACKGROUND);
		expect(at(540, 100)).toEqual(BACKGROUND);
		// The marker's centre dot.
		expect(at(600, 315)).toEqual([255, 210, 63, 255]);
	});

	test("rev selects the version of the map", async () => {
		const t = await withTiles();
		const old = await decode(
			await t.app.request("/api/preview.png?x=16&z=8&zoom=-2&rev=1"),
		);
		expect(old.at(540, 315)).toEqual([255, 0, 0, 255]);
		expect(old.at(655, 315)).toEqual(BACKGROUND);
		const empty = await decode(
			await t.app.request("/api/preview.png?x=16&z=8&zoom=-2&rev=0"),
		);
		expect(empty.at(540, 315)).toEqual(BACKGROUND);
		// A rev from the future is clamped to the head.
		const future = await decode(
			await t.app.request("/api/preview.png?x=16&z=8&zoom=-2&rev=999"),
		);
		expect(future.at(655, 315)).toEqual([0, 0, 255, 255]);
	});

	test("zoomed-out views come from the pyramid; the dimension and defaults work", async () => {
		const t = await withTiles();
		const out = await decode(
			await t.app.request("/api/preview.png?x=16&z=8&zoom=3"),
		);
		// 8 blocks per pixel: both tiles together are about 4 pixels, right at the centre.
		expect(out.at(100, 100)).toEqual(BACKGROUND);
		const near = [
			out.at(598, 313),
			out.at(599, 314),
			out.at(600, 316),
			out.at(601, 317),
		];
		expect(near.some((p) => p[0] !== 27 || p[2] !== 34)).toBe(true);

		expect((await t.app.request("/api/preview.png")).status).toBe(200);
		expect((await t.app.request("/api/preview.png?dim=nether")).status).toBe(
			200,
		);
		expect((await t.app.request("/api/preview.png?zoom=99")).status).toBe(200);
	});

	test("a view with huge numbers of tiles still renders (coarser level)", async () => {
		const t = await withTiles();
		const res = await t.app.request("/api/preview.png?x=0&z=0&zoom=0");
		expect(res.status).toBe(200);
	});

	test("validates input and reports unknown maps and dimensions", async () => {
		const t = await withTiles();
		for (const q of ["x=abc", "z=1.5", "rev=-1", "x=99999999999", "zoom=NaN"]) {
			expect((await t.app.request(`/api/preview.png?${q}`)).status).toBe(400);
		}
		expect((await t.app.request("/api/preview.png?map=nope")).status).toBe(404);
		expect((await t.app.request("/api/preview.png?dim=nope")).status).toBe(404);
	});

	test("results are cached on disk and identical concurrent requests share one render", async () => {
		const t = await withTiles();
		const url = "/api/preview.png?x=16&z=8&zoom=-2";
		const responses = await Promise.all(
			Array.from({ length: 5 }, () => t.app.request(url)),
		);
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
		expect(cacheFiles(t)).toHaveLength(1);
		const bodies = await Promise.all(
			responses.map(async (r) => Buffer.from(await r.arrayBuffer())),
		);
		expect(bodies.every((b) => b.equals(bodies[0] as Buffer))).toBe(true);

		await t.app.request(url); // served from disk
		expect(cacheFiles(t)).toHaveLength(1);
		await t.app.request("/api/preview.png?x=17&z=8&zoom=-2");
		expect(cacheFiles(t)).toHaveLength(2);
		// Same view with the default rev spelled out is the same picture.
		await t.app.request("/api/preview.png?x=16&z=8&zoom=-2&rev=2");
		expect(cacheFiles(t)).toHaveLength(2);
	});

	test("cache headers: pinned revisions are cached longer", async () => {
		const t = await withTiles();
		const latest = await t.app.request("/api/preview.png?x=16&z=8&zoom=-2");
		expect(latest.headers.get("cache-control")).toBe("public, max-age=300");
		const pinned = await t.app.request(
			"/api/preview.png?x=16&z=8&zoom=-2&rev=1",
		);
		expect(pinned.headers.get("cache-control")).toBe("public, max-age=86400");
	});
});

describe("pruneCache", () => {
	test("deletes the oldest files beyond the limit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aomc-prune-"));
		for (let i = 0; i < 5; i++) {
			const file = join(dir, `${i}.png`);
			writeFileSync(file, "x");
			utimesSync(file, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
		}
		writeFileSync(join(dir, "keep.txt"), "not a preview");
		await pruneCache(dir, 3);
		expect(readdirSync(dir).sort()).toEqual([
			"2.png",
			"3.png",
			"4.png",
			"keep.txt",
		]);
		await pruneCache(dir, 3); // nothing to do
		expect(readdirSync(dir)).toHaveLength(4);
	});
});

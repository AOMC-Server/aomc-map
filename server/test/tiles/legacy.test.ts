import { afterAll, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { categoryOf } from "../../src/traffic";

afterAll(cleanupTempDirs);

import {
	BLUE,
	bootTiles,
	cleanupTempDirs,
	decodeRgba,
	RED,
	solid,
	type TileApp,
	upload,
} from "../helpers";

/** v1 tiles are 512 pixels whatever the map's tile size. */
const V1 = 512;
const RED_PX = [255, 0, 0, 255];
const BLUE_PX = [0, 0, 255, 255];
const BLACK_PX = [0, 0, 0, 255];

const boot = (tileSize: number, maxZoom = 3) =>
	bootTiles({
		DEFAULT_TILE_SIZE: String(tileSize),
		MAX_ZOOM: String(maxZoom),
	});

const px = (tile: Buffer, x: number, y: number) => [
	...tile.subarray((y * V1 + x) * 4, (y * V1 + x) * 4 + 4),
];

/** Fetches a v1 tile URL as RGBA; null = 404. */
async function legacy(t: TileApp, path: string) {
	const res = await t.app.request(`/map/overworld/${path}`);
	if (res.status === 404) return null;
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("image/png");
	const bytes = new Uint8Array(await res.arrayBuffer());
	// Like v1: opaque RGB, no alpha channel.
	expect((await sharp(bytes).metadata()).hasAlpha).toBe(false);
	const { data, width, height } = await decodeRgba(bytes);
	expect([width, height]).toEqual([V1, V1]);
	return { tile: Buffer.from(data), etag: res.headers.get("etag") as string };
}

describe("v1 tile URLs", () => {
	test("are named by the block coordinates of their top-left corner", async () => {
		const t = await boot(V1);
		// Half the tile, so the rest is unexplored.
		await upload(t, await solid(V1 / 2, V1, RED), V1, -2 * V1);

		const zoom0 = await legacy(t, `0/${V1}_${-2 * V1}.png`);
		expect(px(zoom0?.tile as Buffer, 2, 2)).toEqual(RED_PX);
		// Unexplored areas are black, as in v1.
		expect(px(zoom0?.tile as Buffer, V1 - 2, 2)).toEqual(BLACK_PX);

		// Zoom 1 spans 1024 blocks: block x 512 is in the right half of the tile at x 0.
		const zoom1 = await legacy(t, `1/0_${-2 * V1}.png`);
		expect(px(zoom1?.tile as Buffer, V1 / 2 + 1, 1)).toEqual(RED_PX);
		expect(px(zoom1?.tile as Buffer, 1, 1)).toEqual(BLACK_PX);
	});

	test("are cut from larger tiles", async () => {
		const t = await boot(1024, 1);
		await upload(t, await solid(1024, 1024, RED), 0, 0);
		await upload(t, await solid(V1, V1, BLUE), V1, V1);

		expect(px((await legacy(t, "0/0_0.png"))?.tile as Buffer, 5, 5)).toEqual(
			RED_PX,
		);
		expect(px((await legacy(t, "0/512_0.png"))?.tile as Buffer, 5, 5)).toEqual(
			RED_PX,
		);
		expect(
			px((await legacy(t, "0/512_512.png"))?.tile as Buffer, 5, 5),
		).toEqual(BLUE_PX);
		expect(await legacy(t, "0/1024_0.png")).toBeNull();

		const zoom1 = (await legacy(t, "1/0_0.png"))?.tile as Buffer;
		expect(px(zoom1, 10, 10)).toEqual(RED_PX);
		expect(px(zoom1, 300, 300)).toEqual(BLUE_PX);
		expect(px(zoom1, 10, 300)).toEqual(RED_PX);

		// Zoom 2 is above MAX_ZOOM here: 4 blocks a pixel, made from zoom 1.
		const zoom2 = (await legacy(t, "2/0_0.png"))?.tile as Buffer;
		expect(px(zoom2, 10, 10)).toEqual(RED_PX);
		expect(px(zoom2, 200, 200)).toEqual(BLUE_PX);
		expect(px(zoom2, 300, 10)).toEqual(BLACK_PX);
	});

	test("a part of a larger tile that is empty is a 404", async () => {
		const t = await boot(1024, 1);
		await upload(t, await solid(V1, V1, RED), 0, 0);
		expect(await legacy(t, "0/0_0.png")).not.toBeNull();
		expect(await legacy(t, "0/512_0.png")).toBeNull();
		expect(await legacy(t, "0/0_512.png")).toBeNull();
	});

	test("are stitched from smaller tiles", async () => {
		const t = await boot(256, 1);
		await upload(t, await solid(V1, V1, RED), 0, 0);
		await upload(t, await solid(256, 256, BLUE), 256, 0);

		const tile = (await legacy(t, "0/0_0.png"))?.tile as Buffer;
		expect(px(tile, 10, 10)).toEqual(RED_PX);
		expect(px(tile, 300, 10)).toEqual(BLUE_PX);
		expect(px(tile, 10, 300)).toEqual(RED_PX);
		expect(px(tile, 300, 300)).toEqual(RED_PX);
	});

	test("answer 404 like v1 for anything without a tile", async () => {
		const t = await boot(V1);
		await upload(t, await solid(V1, V1, RED), 0, 0);
		const status = async (path: string) => (await t.app.request(path)).status;

		expect(await status("/map/overworld/0/0_0.png")).toBe(200);
		// Nothing mapped there.
		expect(await status(`/map/overworld/0/${V1}_0.png`)).toBe(404);
		// Not a tile corner at that zoom.
		expect(await status("/map/overworld/0/1_0.png")).toBe(404);
		expect(await status(`/map/overworld/1/${V1}_0.png`)).toBe(404);
		// Unknown dimension, other names and zooms beyond v1's.
		expect(await status("/map/nope/0/0_0.png")).toBe(404);
		expect(await status("/map/overworld/0/0_0.webp")).toBe(404);
		expect(await status("/map/overworld/0/0,0.png")).toBe(404);
		expect(await status("/map/overworld/x/0_0.png")).toBe(404);
		expect(await status("/map/overworld/10/0_0.png")).toBe(404);
		expect(await status("/map/overworld/0/99999999999999999999_0.png")).toBe(
			404,
		);
		expect(await status("/map/overworld/0")).toBe(404);
	});

	test("ignore v1's subdomain parameter and answer HEAD", async () => {
		const t = await boot(V1);
		await upload(t, await solid(V1, V1, RED), 0, 0);
		expect(await legacy(t, "0/0_0.png?s=b")).not.toBeNull();
		const head = await t.app.request("/map/overworld/0/0_0.png", {
			method: "HEAD",
		});
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toBe("image/png");
	});

	test("always show the latest map, and revalidate with ETags", async () => {
		for (const tileSize of [V1, 1024]) {
			const t = await boot(tileSize, 1);
			await upload(t, await solid(V1, V1, RED), 0, 0);
			const first = await legacy(t, "0/0_0.png");
			const again = await t.app.request("/map/overworld/0/0_0.png", {
				headers: { "If-None-Match": first?.etag as string },
			});
			expect(again.status).toBe(304);
			expect(again.headers.get("cache-control")).toBe("public, max-age=10");

			await upload(t, await solid(V1, V1, BLUE), 0, 0);
			const second = await legacy(t, "0/0_0.png");
			expect(second?.etag).not.toBe(first?.etag);
			expect(px(second?.tile as Buffer, 3, 3)).toEqual(BLUE_PX);
		}
	});

	test("zoom levels above MAX_ZOOM are made from the stored tiles", async () => {
		// MAX_ZOOM is 3: a zoom 4 tile is made from 2x2 tiles of zoom 3, 16 blocks a pixel.
		const t = await boot(V1);
		await upload(t, await solid(V1, V1, RED), 0, 0);
		await upload(t, await solid(V1, V1, BLUE), 8 * V1, 0);

		const zoom4 = await legacy(t, "4/0_0.png");
		expect(px(zoom4?.tile as Buffer, 0, 0)).toEqual(RED_PX);
		expect(px(zoom4?.tile as Buffer, 31, 31)).toEqual(RED_PX);
		expect(px(zoom4?.tile as Buffer, 32, 0)).toEqual(BLACK_PX);
		expect(px(zoom4?.tile as Buffer, 256, 0)).toEqual(BLUE_PX);

		// Zoom 5: 32 blocks a pixel.
		const zoom5 = await legacy(t, "5/0_0.png");
		expect(px(zoom5?.tile as Buffer, 15, 15)).toEqual(RED_PX);
		expect(px(zoom5?.tile as Buffer, 16, 0)).toEqual(BLACK_PX);

		// A new upload changes the made tile too.
		await upload(t, await solid(V1, V1, BLUE), 0, 0);
		const updated = await legacy(t, "4/0_0.png");
		expect(updated?.etag).not.toBe(zoom4?.etag);
		expect(px(updated?.tile as Buffer, 0, 0)).toEqual(BLUE_PX);

		// Empty areas are 404 here too, and no more than two levels are made on the fly.
		expect(await legacy(t, `4/${V1 * 16}_${V1 * 16}.png`)).toBeNull();
		expect(await legacy(t, "6/0_0.png")).toBeNull();
	});

	test("tile sizes needing too many tiles per v1 tile are a 404", async () => {
		const t = await boot(16);
		await upload(t, await solid(16, 16, RED), 0, 0);
		expect(await legacy(t, "0/0_0.png")).toBeNull();
	});

	test("count as tile traffic", () => {
		expect(categoryOf("/map/overworld/0/0_0.png")).toBe("tiles");
	});
});

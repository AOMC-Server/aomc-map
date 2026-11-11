import { afterAll, describe, expect, test } from "bun:test";

afterAll(cleanupTempDirs);

import {
	BLUE,
	bootTiles,
	cleanupTempDirs,
	decodeRgba,
	erase,
	px,
	RED,
	readTile,
	solid,
	T,
	type TileApp,
	upload,
} from "../helpers";

const RED_PX = [255, 0, 0, 255];
const BLUE_PX = [0, 0, 255, 255];
const NONE = [0, 0, 0, 0];

/** One upload's own tile (null = 204), following the redirect at zoom 0. */
async function only(
	t: TileApp,
	id: number,
	zoom: number,
	x: number,
	y: number,
	dim = "overworld",
) {
	let res = await t.app.request(
		`/api/dimensions/${dim}/tiles/${zoom}/${x}/${y}?only=${id}`,
	);
	if (res.status === 302) {
		res = await t.app.request(res.headers.get("location") as string);
	}
	if (res.status === 204) return null;
	expect(res.status).toBe(200);
	return Buffer.from(
		(await decodeRgba(new Uint8Array(await res.arrayBuffer()))).data,
	);
}

async function setup() {
	const t = await bootTiles();
	const a = await upload(t, await solid(T, T, RED), 0, 0);
	const b = await upload(t, await solid(8, T, BLUE), 8, 0);
	return { t, a, b };
}

describe("isolated uploads", () => {
	test("zoom 0 shows only that upload, not what it was composited with", async () => {
		const { t, a, b } = await setup();
		const whole = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(whole, 12, 2)).toEqual(BLUE_PX);

		const first = (await only(t, a, 0, 0, 0)) as Buffer;
		expect(px(first, 2, 2)).toEqual(RED_PX);
		expect(px(first, 12, 2)).toEqual(RED_PX);

		const second = (await only(t, b, 0, 0, 0)) as Buffer;
		expect(px(second, 2, 2)).toEqual(NONE);
		expect(px(second, 12, 2)).toEqual(BLUE_PX);
	});

	test("zoomed-out tiles match a map that only ever had that upload", async () => {
		const { t, a } = await setup();
		const alone = await bootTiles();
		await upload(alone, await solid(T, T, RED), 0, 0);
		for (let zoom = 1; zoom <= 3; zoom++) {
			const expected = (await readTile(alone, zoom, 0, 0)) as Buffer;
			const got = (await only(t, a, zoom, 0, 0)) as Buffer;
			expect(got.equals(expected)).toBe(true);
		}
	});

	test("areas the upload did not reach are empty, at every zoom", async () => {
		const { t, a } = await setup();
		expect(await only(t, a, 0, 5, 5)).toBeNull();
		expect(await only(t, a, 2, 1, 1)).toBeNull();
	});

	test("a deleted upload is gone", async () => {
		const { t, a } = await setup();
		await erase(t, a);
		const res = await t.app.request(
			`/api/dimensions/overworld/tiles/0/0/0?only=${a}`,
		);
		expect(res.status).toBe(404);
	});

	test("an upload that spans several tiles is combined when zoomed out", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(2 * T, T, RED), 0, 0);
		const tile = (await only(t, id, 1, 0, 0)) as Buffer;
		expect(px(tile, 2, 2)).toEqual(RED_PX);
		expect(px(tile, 12, 2)).toEqual(RED_PX);
		expect(px(tile, 2, 12)).toEqual(NONE);
	});

	test("only works for uploads of that dimension", async () => {
		const { t, a } = await setup();
		const res = await t.app.request(
			`/api/dimensions/nether/tiles/0/0/0?only=${a}`,
		);
		expect(res.status).toBe(404);
	});

	test("unknown revisions are not uploads", async () => {
		const { t } = await setup();
		const res = await t.app.request(
			"/api/dimensions/overworld/tiles/0/0/0?only=999",
		);
		expect(res.status).toBe(404);
	});

	test("a bad value is rejected", async () => {
		const { t } = await setup();
		const res = await t.app.request(
			"/api/dimensions/overworld/tiles/0/0/0?only=abc",
		);
		expect(res.status).toBe(400);
	});
});

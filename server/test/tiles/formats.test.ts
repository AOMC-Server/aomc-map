import { afterAll, describe, expect, test } from "bun:test";

afterAll(cleanupTempDirs);

import {
	BLUE,
	bootTiles,
	cleanupTempDirs,
	decodeRgba,
	px,
	RED,
	solid,
	T,
	type TileApp,
	upload,
} from "../helpers";

const RED_PX = [255, 0, 0, 255];
const BLUE_PX = [0, 0, 255, 255];
const BASE = "/api/dimensions/overworld/tiles";

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
	"image/png": (b) => b[0] === 0x89 && b[1] === 0x50,
	"image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
	"image/webp": (b) => new TextDecoder().decode(b.subarray(8, 12)) === "WEBP",
};

/** Fetches a tile URL, following a redirect. null = 204. */
async function fetchImage(t: TileApp, url: string) {
	let res = await t.app.request(url);
	let location: string | null = null;
	if (res.status === 302) {
		location = res.headers.get("location") as string;
		res = await t.app.request(location);
	}
	if (res.status === 204) return null;
	expect(res.status).toBe(200);
	const type = res.headers.get("content-type") as string;
	const bytes = new Uint8Array(await res.arrayBuffer());
	expect(MAGIC[type]?.(bytes)).toBe(true);
	const { data, width, height } = await decodeRgba(bytes);
	expect([width, height]).toEqual([T, T]);
	return { type, location, bytes, tile: Buffer.from(data) };
}

const near = (a: number[], b: number[], tolerance: number) =>
	a.every((v, i) => Math.abs(v - (b[i] as number)) <= tolerance);

/** format=, the blob suffix, the content type and the colour tolerance. */
const CASES = [
	["png", ".png", "image/png", 0],
	["png-black", ".black.png", "image/png", 0],
	["jpg-95", ".95.jpg", "image/jpeg", 8],
	["jpg-80", ".80.jpg", "image/jpeg", 40],
	["webp-lossy", ".lossy.webp", "image/webp", 40],
] as const;

describe("tile formats", () => {
	for (const [format, suffix, type, tolerance] of CASES) {
		test(`format=${format}`, async () => {
			const t = await bootTiles();
			// Half the tile, so the rest is transparent.
			await upload(t, await solid(T / 2, T, RED), 0, 0);
			const q = `format=${format}`;

			const got = await fetchImage(t, `${BASE}/0/0/0?${q}`);
			expect(got?.type).toBe(type);
			expect(got?.location).toEndWith(suffix);
			const tile = got?.tile as Buffer;
			expect(near(px(tile, 2, 2), RED_PX, tolerance)).toBe(true);
			// JPEG and png-black cannot be transparent: empty areas are black.
			const opaque = type === "image/jpeg" || format === "png-black";
			const empty = opaque ? [0, 0, 0, 255] : [0, 0, 0, 0];
			expect(near(px(tile, 13, 2), empty, tolerance)).toBe(true);

			expect(await fetchImage(t, `${BASE}/0/5/5?${q}`)).toBeNull();
			expect(await fetchImage(t, `${BASE}/1/0/0?${q}`)).not.toBeNull();
		});
	}

	test("lossless WebP stays the default", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		for (const url of [`${BASE}/0/0/0`, `${BASE}/0/0/0?format=webp`]) {
			const res = await t.app.request(url);
			expect(res.headers.get("location")).toMatch(/\/[0-9a-f]{64}\.webp$/);
		}
	});

	test("isolated uploads and older revisions work in every format", async () => {
		const t = await bootTiles();
		const a = await upload(t, await solid(T, T, RED), 0, 0);
		await upload(t, await solid(T, T, BLUE), 0, 0);

		for (const [format, , type, tolerance] of CASES) {
			const q = `format=${format}`;
			const old = await fetchImage(t, `${BASE}/0/0/0?rev=1&${q}`);
			expect(near(px(old?.tile as Buffer, 3, 3), RED_PX, tolerance)).toBe(true);
			const head = await fetchImage(t, `${BASE}/0/0/0?${q}`);
			expect(near(px(head?.tile as Buffer, 3, 3), BLUE_PX, tolerance)).toBe(
				true,
			);

			const iso0 = await fetchImage(t, `${BASE}/0/0/0?only=${a}&${q}`);
			expect(near(px(iso0?.tile as Buffer, 3, 3), RED_PX, tolerance)).toBe(
				true,
			);
			// Above zoom 0 the isolated tile is made on the fly and sent directly.
			const iso1 = await fetchImage(t, `${BASE}/1/0/0?only=${a}&${q}`);
			expect(iso1?.location).toBeNull();
			expect(iso1?.type).toBe(type);
			expect(near(px(iso1?.tile as Buffer, 3, 3), RED_PX, tolerance)).toBe(
				true,
			);
		}
	});

	test("converted images are kept on disk next to the WebP", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const res = await t.app.request(`${BASE}/0/0/0`);
		const hash = (res.headers.get("location") as string).slice(7, 71);
		const webpPath = t.services.blobs.path(hash);

		for (const [, suffix] of CASES) {
			const onDisk = webpPath.replace(/\.webp$/, suffix);
			expect(await Bun.file(onDisk).exists()).toBe(false);

			const [a, b] = await Promise.all([
				t.app.request(`/blobs/${hash}${suffix}`),
				t.app.request(`/blobs/${hash}${suffix}`),
			]);
			const first = new Uint8Array(await (a as Response).arrayBuffer());
			expect(new Uint8Array(await (b as Response).arrayBuffer())).toEqual(
				first,
			);
			expect(await Bun.file(onDisk).exists()).toBe(true);

			const again = await t.app.request(`/blobs/${hash}${suffix}`);
			expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
			expect(again.headers.get("content-length")).toBe(String(first.length));
		}
	});

	test("bad formats are rejected", async () => {
		const t = await bootTiles();
		const status = async (url: string) => (await t.app.request(url)).status;
		expect(await status(`${BASE}/0/0/0?format=jpg`)).toBe(400);
		expect(await status(`${BASE}/0/0/0?format=gif`)).toBe(400);
		// The format is chosen with format= only, not with an extension.
		expect(await status(`${BASE}/0/0/0.png`)).toBe(400);
		expect(await status(`${BASE}/0/0/0.webp`)).toBe(400);
		const zero = "0".repeat(64);
		expect(await status(`/blobs/${zero}.png`)).toBe(404);
		expect(await status(`/blobs/${zero}.jpg`)).toBe(404);
		expect(await status(`/blobs/${zero}.70.jpg`)).toBe(404);
	});
});

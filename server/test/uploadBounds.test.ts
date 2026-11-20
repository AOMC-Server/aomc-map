import { afterAll, describe, expect, test } from "bun:test";
import { MAX_COORD, UPLOAD_COORD_MARGIN } from "@aomc/shared";
import { parseXaeroCoords } from "@aomc/shared/xaero";
import {
	bootTiles,
	cleanupTempDirs,
	postUpload,
	RED,
	readTile,
	solid,
	T,
	upload,
} from "./helpers";

afterAll(cleanupTempDirs);

describe("uploads at the world border", () => {
	test("file names a little past the border are read, much further are not", () => {
		const at = (x: number) => parseXaeroCoords(`a_x${x}_z-${x}.png`);
		expect(at(MAX_COORD)).toEqual({ x: MAX_COORD, z: -MAX_COORD });
		expect(at(MAX_COORD + UPLOAD_COORD_MARGIN)).not.toBeNull();
		expect(at(MAX_COORD + UPLOAD_COORD_MARGIN + 1)).toBeNull();
	});

	test("a tile past the border uploads and shows up on the map", async () => {
		const t = await bootTiles();
		const x = MAX_COORD + 5 * T;
		const z = -MAX_COORD - 5 * T;
		const rev = await upload(t, await solid(T, T, RED), x, z);
		expect(rev).toBeGreaterThan(0);
		const tile = await readTile(t, 0, x / T, z / T);
		expect(tile).not.toBeNull();
	});

	test("explicit coordinates are limited too", async () => {
		const t = await bootTiles();
		const far = MAX_COORD + UPLOAD_COORD_MARGIN + 1;
		const res = await postUpload(
			t,
			t.editor,
			[{ name: "a.png", data: await solid(T, T, RED) }],
			{ coords: [{ x: far, z: 0 }] },
		);
		expect(res.status).toBe(400);
	});
});

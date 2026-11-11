import { afterAll, describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { revisions } from "../../src/db/schema";

afterAll(cleanupTempDirs);

import {
	BLUE,
	bootTiles,
	cleanupTempDirs,
	erase,
	GREEN,
	postUpload,
	px,
	RED,
	readTile,
	revisionOf,
	solid,
	T,
	upload,
	uploadFrom,
	uploadMany,
} from "../helpers";

const RED_PX = [255, 0, 0, 255];
const BLUE_PX = [0, 0, 255, 255];

const OLD = "2026-02-09_19.45.47_x0_z0.png";
const NEW = "2026-03-01_10.00.00_x0_z0.png";

describe("export dates", () => {
	test("the date is stored on the revision", async () => {
		const t = await bootTiles();
		const id = await uploadFrom(t, await solid(T, T, RED), 0, 0, OLD);
		const rev = await revisionOf(t, id);
		expect(rev.exportedAt).toBe(Date.UTC(2026, 1, 9, 19, 45, 47));
	});

	test("an older export uploaded later goes underneath the newer one", async () => {
		const t = await bootTiles();
		// New export: red over the left half. Old export: blue over the whole tile.
		await uploadFrom(t, await solid(8, T, RED), 0, 0, NEW);
		await uploadFrom(t, await solid(T, T, BLUE), 0, 0, OLD);
		const tile = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(tile, 2, 2)).toEqual(RED_PX);
		expect(px(tile, 12, 2)).toEqual(BLUE_PX);
	});

	test("a newer export uploaded later still goes on top", async () => {
		const t = await bootTiles();
		await uploadFrom(t, await solid(T, T, BLUE), 0, 0, OLD);
		await uploadFrom(t, await solid(8, T, RED), 0, 0, NEW);
		const tile = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(tile, 2, 2)).toEqual(RED_PX);
		expect(px(tile, 12, 2)).toEqual(BLUE_PX);
	});

	test("the result does not depend on the order the exports were uploaded in", async () => {
		const a = await bootTiles();
		await uploadFrom(a, await solid(8, T, RED), 0, 0, NEW);
		await uploadFrom(a, await solid(T, T, BLUE), 0, 0, OLD);
		const b = await bootTiles();
		await uploadFrom(b, await solid(T, T, BLUE), 0, 0, OLD);
		await uploadFrom(b, await solid(8, T, RED), 0, 0, NEW);
		const ta = (await readTile(a, 0, 0, 0)) as Buffer;
		const tb = (await readTile(b, 0, 0, 0)) as Buffer;
		expect(ta.equals(tb)).toBe(true);
		for (let zoom = 1; zoom <= 3; zoom++) {
			const za = (await readTile(a, zoom, 0, 0)) as Buffer;
			const zb = (await readTile(b, zoom, 0, 0)) as Buffer;
			expect(za.equals(zb)).toBe(true);
		}
	});

	test("an upload without a date counts as made now, so older exports go under it", async () => {
		const t = await bootTiles();
		await upload(t, await solid(8, T, RED), 0, 0);
		await uploadFrom(t, await solid(T, T, BLUE), 0, 0, OLD);
		const tile = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(tile, 2, 2)).toEqual(RED_PX);
		expect(px(tile, 12, 2)).toEqual(BLUE_PX);
	});

	test("an export from the future is treated as made now", async () => {
		const t = await bootTiles();
		const id = await uploadFrom(
			t,
			await solid(T, T, RED),
			0,
			0,
			"2999-01-01_00.00.00_x0_z0.png",
		);
		const rev = await revisionOf(t, id);
		expect(rev.exportedAt).toBeLessThanOrEqual(Date.now());
	});

	test("deleting the newest export brings back what was under it", async () => {
		const t = await bootTiles();
		await uploadFrom(t, await solid(T, T, BLUE), 0, 0, OLD);
		const newer = await uploadFrom(t, await solid(T, T, RED), 0, 0, NEW);
		// An even older export, uploaded last, is hidden beneath both.
		await uploadFrom(
			t,
			await solid(T, T, GREEN),
			0,
			0,
			"2026-01-01_00.00.00_x0_z0.png",
		);
		expect(px((await readTile(t, 0, 0, 0)) as Buffer, 2, 2)).toEqual(RED_PX);
		await erase(t, newer);
		expect(px((await readTile(t, 0, 0, 0)) as Buffer, 2, 2)).toEqual(BLUE_PX);
	});

	test("an older export that adds nothing new changes no tiles", async () => {
		const t = await bootTiles();
		await uploadFrom(t, await solid(T, T, RED), 0, 0, NEW);
		const before = (await readTile(t, 0, 0, 0)) as Buffer;
		await uploadFrom(t, await solid(T, T, BLUE), 0, 0, OLD);
		const after = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(after.equals(before)).toBe(true);
	});

	test("every export becomes its own revision, oldest first, whatever the file order", async () => {
		const t = await bootTiles();
		const red = await solid(T, T, RED);
		const blue = await solid(T, T, BLUE);
		await uploadMany(t, [
			// Two files of the same folder share a date and so a revision.
			{ data: red, x: 0, z: 0, path: "2026-03-01_10.00.00/1_0_x0_z0.png" },
			{ data: red, x: 16, z: 0, path: "2026-03-01_10.00.00/1_1_x16_z0.png" },
			{ data: blue, x: 0, z: 0, path: "2026-02-09_19.45.47/0_0_x0_z0.png" },
			{ data: blue, x: 0, z: 16, path: "no date here.png" },
		]);
		const rows = await t.db
			.select()
			.from(revisions)
			.orderBy(asc(revisions.id))
			.all();
		expect(rows.map((r) => [r.exportedAt, r.fileCount, r.rev])).toEqual([
			[Date.UTC(2026, 1, 9, 19, 45, 47), 1, 1],
			[Date.UTC(2026, 2, 1, 10, 0, 0), 2, 2],
			[null, 1, 3],
		]);
		// The red export is newer than the blue one where they overlap.
		expect(px((await readTile(t, 0, 0, 0)) as Buffer, 2, 2)).toEqual(RED_PX);
	});

	test("the folder of a zip carries the date", async () => {
		const { zipSync } = await import("fflate");
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const zip = zipSync({
			"2026-02-09_19.45.47/0_0_x0_z0.png": new Uint8Array(
				await solid(T, T, BLUE),
			),
		});
		const res = await postUpload(t, t.editor, [
			{ name: "exports.zip", data: zip },
		]);
		expect(res.status).toBe(202);
		await t.services.worker.run();
		const rows = await t.db
			.select()
			.from(revisions)
			.orderBy(asc(revisions.id))
			.all();
		expect(rows[1]?.exportedAt).toBe(Date.UTC(2026, 1, 9, 19, 45, 47));
		// Older than the undated upload, so it only fills gaps.
		expect(px((await readTile(t, 0, 0, 0)) as Buffer, 2, 2)).toEqual(RED_PX);
	});

	test("paths must match the files", async () => {
		const t = await bootTiles();
		const res = await postUpload(
			t,
			t.editor,
			[{ name: "a.png", data: await solid(T, T, RED) }],
			{ coords: [{ x: 0, z: 0 }], paths: ["a.png", "b.png"] },
		);
		expect(res.status).toBe(400);
	});
});

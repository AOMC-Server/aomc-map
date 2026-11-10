import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs, maps, revisions } from "../../src/db/schema";
import { incomingDir } from "../../src/jobs/types";
import {
	BLACK,
	BLUE,
	bootTiles,
	GREEN,
	png,
	px,
	RED,
	readTile,
	revert,
	revisionOf,
	solid,
	T,
	upload,
	uploadMany,
} from "../helpers";

const RED_PX = [255, 0, 0, 255];
const BLUE_PX = [0, 0, 255, 255];
const GREEN_PX = [0, 255, 0, 255];
const NONE = [0, 0, 0, 0];

describe("upload", () => {
	test("spanning tile boundaries at negative coordinates", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(20, 20, RED), -10, -10);

		const rev = await revisionOf(t, id);
		expect(rev.status).toBe("done");
		expect(rev.rev).toBe(1);
		expect(rev.bbox).toEqual({ minX: -10, minZ: -10, maxX: 9, maxZ: 9 });
		const [map] = await t.db.select().from(maps).where(eq(maps.id, t.mapId));
		expect(map?.headRev).toBe(1);

		// Tile -1 covers blocks -16..-1: image starts at local 6.
		const topLeft = (await readTile(t, 0, -1, -1)) as Buffer;
		expect(px(topLeft, 5, 5)).toEqual(NONE);
		expect(px(topLeft, 6, 6)).toEqual(RED_PX);
		expect(px(topLeft, 15, 15)).toEqual(RED_PX);

		// Tile 0 covers 0..15: image ends at local 9.
		const bottomRight = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(bottomRight, 0, 0)).toEqual(RED_PX);
		expect(px(bottomRight, 9, 9)).toEqual(RED_PX);
		expect(px(bottomRight, 10, 10)).toEqual(NONE);

		// Mixed tiles: x in tile -1, z in tile 0.
		const mixed = (await readTile(t, 0, -1, 0)) as Buffer;
		expect(px(mixed, 6, 0)).toEqual(RED_PX);
		expect(px(mixed, 6, 10)).toEqual(NONE);
		expect(await readTile(t, 0, 1, 1)).toBeNull();
	});

	test("black pixels are transparent and never overwrite earlier files in the same upload", async () => {
		const t = await bootTiles();
		const first = await solid(T, T, GREEN);
		const second = await png(T, T, (x) => (x < 8 ? BLACK : RED));
		await uploadMany(t, [
			{ data: first, x: 0, z: 0 },
			{ data: second, x: 0, z: 0 },
		]);
		const tile = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(tile, 2, 2)).toEqual(GREEN_PX);
		expect(px(tile, 12, 2)).toEqual(RED_PX);
	});

	test("builds the pyramid up to MAX_ZOOM", async () => {
		const t = await bootTiles();
		await upload(t, await solid(20, 20, RED), -10, -10);

		// zoom 1 tile (-1,-1) holds child (-1,-1) in its bottom-right quadrant, halved.
		const z1 = (await readTile(t, 1, -1, -1)) as Buffer;
		expect(px(z1, 0, 0)).toEqual(NONE);
		expect(px(z1, 9, 9)).toEqual(NONE);
		expect(px(z1, 11, 11)).toEqual(RED_PX);
		expect(px(z1, 15, 15)).toEqual(RED_PX);

		// zoom 1 tile (0,0): child (0,0) in the top-left quadrant, red up to local 9 -> 4.
		const z1b = (await readTile(t, 1, 0, 0)) as Buffer;
		expect(px(z1b, 4, 4)).toEqual(RED_PX);
		expect(px(z1b, 6, 6)).toEqual(NONE);

		// Every ancestor up to MAX_ZOOM exists and is non-empty.
		for (const [zoom, tx, ty] of [
			[2, -1, -1],
			[2, 0, 0],
			[3, -1, -1],
			[3, 0, 0],
		] as const) {
			expect(await readTile(t, zoom, tx, ty)).not.toBeNull();
		}
		// Zoom 3 tile (-1,-1) covers zoom-2 tiles (-2..-1): only the bottom-right quadrant has data.
		const z3 = (await readTile(t, 3, -1, -1)) as Buffer;
		expect(px(z3, 0, 0)).toEqual(NONE);
		expect(z3[(15 * T + 15) * 4 + 3]).toBeGreaterThan(0);
	});

	test("an unchanged re-upload adds a revision but no tile writes", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const again = await upload(t, await solid(T, T, RED), 0, 0);
		expect((await revisionOf(t, again)).rev).toBe(2);
		const rows = await t.db.query.tileVersions.findMany();
		expect(rows.filter((r) => r.rev === 2)).toHaveLength(0);
	});
});

describe("history lookup", () => {
	test("older revs show older content, head is the default, future revs are rejected", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		await upload(t, await solid(T, T, BLUE), 0, 0);

		expect(await readTile(t, 0, 0, 0, 0)).toBeNull();
		expect(px((await readTile(t, 0, 0, 0, 1)) as Buffer, 3, 3)).toEqual(RED_PX);
		expect(px((await readTile(t, 0, 0, 0, 2)) as Buffer, 3, 3)).toEqual(
			BLUE_PX,
		);
		expect(px((await readTile(t, 0, 0, 0)) as Buffer, 3, 3)).toEqual(BLUE_PX);

		const base = "/api/maps/aomc/dimensions/overworld/tiles/0/0/0";
		expect((await t.app.request(`${base}?rev=3`)).status).toBe(400);
		expect((await t.app.request(`${base}?rev=abc`)).status).toBe(400);

		const pinned = await t.app.request(`${base}?rev=1`);
		expect(pinned.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		const unpinned = await t.app.request(base);
		expect(unpinned.headers.get("cache-control")).toBe("public, max-age=10");
	});

	test("dimensions are independent", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0, t.editor, "nether");
		expect(await readTile(t, 0, 0, 0)).toBeNull();
		expect(await readTile(t, 0, 0, 0, undefined, "nether")).not.toBeNull();
	});
});

describe("revert and unrevert", () => {
	// A: red over the whole tile (0,0). B: blue over its right half.
	async function setup() {
		const t = await bootTiles();
		const a = await upload(t, await solid(T, T, RED), 0, 0);
		const b = await upload(t, await solid(8, T, BLUE), 8, 0);
		return { t, a, b };
	}

	test("a later overlapping upload survives reverting an earlier one", async () => {
		const { t, a } = await setup();
		await revert(t, a);
		const tile = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(tile, 2, 2)).toEqual(NONE);
		expect(px(tile, 12, 2)).toEqual(BLUE_PX);
		// History is not rewritten.
		expect(px((await readTile(t, 0, 0, 0, 2)) as Buffer, 2, 2)).toEqual(RED_PX);
		expect(await readTile(t, 3, 0, 0)).not.toBeNull();
	});

	test("unrevert restores the original result", async () => {
		const { t, a } = await setup();
		const before = (await readTile(t, 0, 0, 0)) as Buffer;
		await revert(t, a);
		await revert(t, a, "unrevert");
		const after = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(after.equals(before)).toBe(true);
		expect(px(after, 2, 2)).toEqual(RED_PX);
		expect(px(after, 12, 2)).toEqual(BLUE_PX);
	});

	test("reverting the upload that created a tile makes it empty at every zoom", async () => {
		const t = await bootTiles();
		const a = await upload(t, await solid(T, T, RED), 0, 0);
		await revert(t, a);
		for (let zoom = 0; zoom <= 3; zoom++)
			expect(await readTile(t, zoom, 0, 0)).toBeNull();
		expect(await readTile(t, 0, 0, 0, 1)).not.toBeNull();
	});

	test("an earlier revert is not undone by reverting a later upload", async () => {
		const { t, a, b } = await setup();
		await revert(t, a);
		await revert(t, b);
		expect(await readTile(t, 0, 0, 0)).toBeNull();
		await revert(t, a, "unrevert");
		const tile = (await readTile(t, 0, 0, 0)) as Buffer;
		expect(px(tile, 12, 2)).toEqual(RED_PX);
	});

	test("revert revisions get their own rev, copy the bbox and flag the target", async () => {
		const { t, a } = await setup();
		const op = await revert(t, a);
		const opRev = await revisionOf(t, op);
		expect(opRev).toMatchObject({
			kind: "revert",
			status: "done",
			rev: 3,
			targetRevisionId: a,
		});
		expect(opRev.bbox).toEqual((await revisionOf(t, a)).bbox);
		expect((await revisionOf(t, a)).reverted).toBe(true);
	});

	test("request validation: state, role, kind", async () => {
		const { t, a } = await setup();
		const post = (id: number, kind: string, user = t.mod) =>
			t.app.request(`/api/revisions/${id}/${kind}`, {
				method: "POST",
				headers: user.auth,
			});

		expect((await post(a, "revert", t.editor)).status).toBe(403);
		expect((await post(a, "unrevert")).status).toBe(409);
		expect((await post(9999, "revert")).status).toBe(404);
		await revert(t, a);
		expect((await post(a, "revert")).status).toBe(409);
		const op = (
			await t.db.select().from(revisions).where(eq(revisions.kind, "revert"))
		)[0];
		expect((await post(op?.id as number, "revert")).status).toBe(400);
		expect(
			(await t.app.request(`/api/revisions/${a}/revert`, { method: "POST" }))
				.status,
		).toBe(401);
	});
});

describe("failures", () => {
	test("a failed job leaves no visible tiles and does not move head", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const [rev] = await t.db
			.insert(revisions)
			.values({
				mapId: t.mapId,
				kind: "upload",
				dimensionId: 1,
				authorId: "editor",
				fileCount: 1,
			})
			.returning({ id: revisions.id });
		const revisionId = (rev as { id: number }).id;
		await t.db.insert(jobs).values({
			type: "process_upload",
			payload: { revisionId, files: [{ x: 0, z: 0, width: T, height: T }] }, // no incoming file
		});
		await t.services.worker.run();

		const failed = await revisionOf(t, revisionId);
		expect(failed.status).toBe("failed");
		expect(failed.rev).toBeNull();
		const [map] = await t.db.select().from(maps).where(eq(maps.id, t.mapId));
		expect(map?.headRev).toBe(1);
		const [job] = await t.db.select().from(jobs).where(eq(jobs.id, 2));
		expect(job?.status).toBe("failed");
	});

	test("an upload with no map data fails cleanly", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, BLACK), 0, 0);
		const rev = await revisionOf(t, id);
		expect(rev.status).toBe("failed");
		expect(rev.error).toContain("no map data");
	});

	test("jobs interrupted mid-processing are retried on start", async () => {
		const t = await bootTiles();
		const [rev] = await t.db
			.insert(revisions)
			.values({
				mapId: t.mapId,
				kind: "upload",
				dimensionId: 1,
				authorId: "editor",
				status: "processing",
			})
			.returning({ id: revisions.id });
		const revisionId = (rev as { id: number }).id;
		await Bun.write(
			`${incomingDir(t.env, revisionId)}/0.png`,
			await solid(T, T, RED),
		);
		await t.db.insert(jobs).values({
			type: "process_upload",
			status: "processing",
			payload: { revisionId, files: [{ x: 0, z: 0, width: T, height: T }] },
		});

		t.services.worker.start();
		t.services.worker.stop();
		await t.services.worker.run();

		expect((await revisionOf(t, revisionId)).status).toBe("done");
		expect(await readTile(t, 0, 0, 0)).not.toBeNull();
	});
});

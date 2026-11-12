import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { dimensions, jobs, mapInfo, revisions } from "../../src/db/schema";
import type { RevisionEvent } from "../../src/events";
import { messages } from "../../src/jobs/messages";
import { incomingDir } from "../../src/jobs/types";

afterAll(cleanupTempDirs);

import {
	BLACK,
	BLUE,
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	GREEN,
	makeUser,
	png,
	px,
	RED,
	readTile,
	revisionOf,
	solid,
	T,
	type TileApp,
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
		const map = await t.db.select().from(mapInfo).get();
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
		expect(px(z3, 15, 15)).toEqual(RED_PX);
	});

	test("an unchanged re-upload adds a revision but no tile writes", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		// Not the same file (that would be skipped), but nothing new: black is "no data".
		const partial = await png(T, T, (_, y) => (y === 0 ? BLACK : RED));
		const again = await upload(t, partial, 0, 0);
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

		const base = "/api/dimensions/overworld/tiles/0/0/0";
		expect((await t.app.request(`${base}?rev=3`)).status).toBe(400);
		expect((await t.app.request(`${base}?rev=abc`)).status).toBe(400);

		const pinned = await t.app.request(`${base}?rev=1&v=0`);
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

describe("deleting an upload", () => {
	/** Uploads that overlap on two tiles; `skip` leaves one out, as if it was never made. */
	async function history(skip?: number) {
		const t = await bootTiles();
		const steps = [
			async () => upload(t, await solid(2 * T, T, RED), 0, 0),
			async () => upload(t, await solid(T, 2 * T, BLUE), 8, -8),
			async () => upload(t, await solid(T, T, GREEN), 4, 0),
			async () => upload(t, await solid(2 * T, 2 * T, RED), 16, 16),
		];
		const ids: number[] = [];
		for (const [i, step] of steps.entries()) {
			if (i !== skip) ids.push(await step());
		}
		return { t, ids };
	}

	/** Every tile at every zoom as of `rev`, for comparing two maps. */
	async function snapshot(t: TileApp, rev?: number) {
		const out: Record<string, number[] | null> = {};
		for (let zoom = 0; zoom <= 3; zoom++) {
			for (let y = -2; y <= 3; y++) {
				for (let x = -2; x <= 3; x++) {
					const tile = await readTile(t, zoom, x, y, rev);
					out[`${zoom}/${x}/${y}`] = tile ? [...tile] : null;
				}
			}
		}
		return out;
	}

	test("it is as if the upload was never made, at every revision", async () => {
		for (const skip of [0, 1, 2, 3]) {
			const full = await history();
			await erase(full.t, full.ids[skip] as number);
			const without = await history(skip);

			// Revisions after the deleted one keep their numbers, so there is a gap.
			const gap = skip + 1;
			const head = full.ids.length;
			expect(await snapshot(full.t)).toEqual(await snapshot(without.t));
			for (let rev = 0; rev <= head; rev++) {
				if (rev === gap) continue;
				const there = rev < gap ? rev : rev - 1;
				expect(await snapshot(full.t, rev)).toEqual(
					await snapshot(without.t, there),
				);
			}
		}
	});

	test("the upload leaves the log, its patches and the job history", async () => {
		const { t, ids } = await history();
		const gone = ids[1] as number;
		await erase(t, gone);
		expect((await t.app.request(`/api/revisions/${gone}`)).status).toBe(404);
		const list = (await (await t.app.request("/api/revisions")).json()) as {
			revisions: { id: number }[];
		};
		expect(list.revisions.map((r) => r.id)).not.toContain(gone);
		const jobRows = await t.db.select().from(jobs);
		expect(
			jobRows.filter(
				(j) => (j.payload as { revisionId: number }).revisionId === gone,
			),
		).toEqual([]);
		const isolated = await t.app.request(
			`/api/dimensions/overworld/tiles/0/0/0?only=${gone}`,
		);
		expect(isolated.status).toBe(404);
	});

	test("deleting the newest upload moves the head back, and the next upload reuses the number", async () => {
		const { t, ids } = await history();
		await erase(t, ids.at(-1) as number);
		expect((await t.db.select().from(mapInfo).get())?.headRev).toBe(3);
		expect(await readTile(t, 0, 2, 2)).toBeNull();

		const next = await upload(t, await solid(T, T, BLUE), 0, 0);
		expect((await revisionOf(t, next)).rev).toBe(4);
		expect(px((await readTile(t, 0, 0, 0)) as Buffer, 2, 2)).toEqual(BLUE_PX);
	});

	test("an erase reports its progress", async () => {
		const { t, ids } = await history();
		const events: RevisionEvent[] = [];
		const unsubscribe = t.services.events.subscribe(
			`revision:${ids[0] as number}`,
			(e) => events.push(e),
		);
		await erase(t, ids[0] as number);
		unsubscribe();
		const steps = events.filter((e) => e.status !== "gone");
		const tiles = steps.filter((e) => e.message === messages.erase.tiles);
		expect(tiles.length).toBeGreaterThan(0);
		expect(tiles.at(-1)?.done).toBe(tiles.at(-1)?.total);
		expect(steps.map((e) => e.message)).toContain(messages.erase.publishing);
		// The erased upload is gone.
		expect(events.at(-1)).toEqual({ status: "gone" });
	});

	test("an erase bumps the map epoch, so cached tiles are not reused", async () => {
		const { t, ids } = await history();
		const epoch = async () =>
			(
				(await (await t.app.request("/api/map")).json()) as {
					map: { epoch: number };
				}
			).map.epoch;
		expect(await epoch()).toBe(0);
		await erase(t, ids[0] as number);
		expect(await epoch()).toBe(1);
	});

	test("a failed erase leaves the upload exactly as it was", async () => {
		const { t, ids } = await history();
		await rm(`${t.env.DATA_DIR}/blobs`, { recursive: true, force: true });
		await erase(t, ids[1] as number);
		const rev = await revisionOf(t, ids[1] as number);
		expect(rev.status).toBe("done");
		expect(rev.error).toContain("delete failed");
		expect((await t.db.select().from(mapInfo).get())?.headRev).toBe(4);
	});

	test("request validation: role, kind, state", async () => {
		const { t, ids } = await history();
		const del = (id: number, user: { auth: Record<string, string> } | null) =>
			t.app.request(`/api/revisions/${id}`, {
				method: "DELETE",
				headers: user?.auth ?? {},
			});
		const a = ids[0] as number;

		const other = await makeUser(t.db, "other");
		expect((await del(a, null)).status).toBe(401);
		expect((await del(a, other)).status).toBe(403);
		expect((await del(9999, t.mod)).status).toBe(404);

		await t.db
			.update(revisions)
			.set({ status: "processing" })
			.where(eq(revisions.id, a));
		expect((await del(a, t.mod)).status).toBe(409);
	});

	test("the author may delete their own upload within the window", async () => {
		const { t, ids } = await history();
		const [a, b] = ids as [number, number];
		const del = (id: number, user: { auth: Record<string, string> }) =>
			t.app.request(`/api/revisions/${id}`, {
				method: "DELETE",
				headers: user.auth,
			});
		const list = await call(t, t.editor, "GET", "/api/revisions");
		const own = list.body.revisions.find((r: { id: number }) => r.id === a);
		expect(own.canDelete).toBe(true);
		expect(own.deletableUntil).toBe(own.createdAt + 24 * 3_600_000);
		const asMod = await call(t, t.mod, "GET", `/api/revisions/${a}`);
		expect(asMod.body.revision).toMatchObject({
			canDelete: true,
			deletableUntil: null,
		});
		const anon = await call(t, null, "GET", `/api/revisions/${a}`);
		expect(anon.body.revision.canDelete).toBe(false);

		// Too late: only a moderator can delete it now.
		await t.db
			.update(revisions)
			.set({ createdAt: Date.now() - 25 * 3_600_000 })
			.where(eq(revisions.id, b));
		expect((await del(b, t.editor)).status).toBe(403);
		const late = await call(t, t.editor, "GET", `/api/revisions/${b}`);
		expect(late.body.revision.canDelete).toBe(false);

		await erase(t, a, t.editor);
		expect((await t.app.request(`/api/revisions/${a}`)).status).toBe(404);
	});

	test("a window of 0 leaves deleting to moderators", async () => {
		const t = await bootTiles({ SELF_DELETE_WINDOW_HOURS: "0" });
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const res = await t.app.request(`/api/revisions/${id}`, {
			method: "DELETE",
			headers: t.editor.auth,
		});
		expect(res.status).toBe(403);
	});

	test("a failed upload is simply removed", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, BLACK), 0, 0);
		expect((await revisionOf(t, id)).status).toBe("failed");
		const res = await t.app.request(`/api/revisions/${id}`, {
			method: "DELETE",
			headers: t.mod.auth,
		});
		expect(res.status).toBe(200);
		expect((await t.app.request(`/api/revisions/${id}`)).status).toBe(404);
	});
});

describe("failures", () => {
	const FILES = [{ x: 0, z: 0, width: T, height: T }];

	/** Queues an upload job directly, so tests control its state and whether its file exists. */
	async function queueUpload(
		t: Awaited<ReturnType<typeof bootTiles>>,
		job: Partial<typeof jobs.$inferInsert> = {},
		status: "pending" | "processing" = "pending",
	) {
		const dim = await t.db.query.dimensions.findFirst({
			where: eq(dimensions.slug, "overworld"),
		});
		const [rev] = await t.db
			.insert(revisions)
			.values({
				kind: "upload",
				dimensionId: (dim as { id: number }).id,
				authorId: "editor",
				fileCount: 1,
				status,
			})
			.returning({ id: revisions.id });
		const revisionId = (rev as { id: number }).id;
		const [row] = await t.db
			.insert(jobs)
			.values({
				type: "process_upload",
				status,
				payload: { revisionId, files: FILES },
				...job,
			})
			.returning({ id: jobs.id });
		return { revisionId, jobId: (row as { id: number }).id };
	}

	const jobStatus = async (
		t: Awaited<ReturnType<typeof bootTiles>>,
		jobId: number,
	) => (await t.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]?.status;

	test("a failed job leaves no visible tiles and does not move head", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const { revisionId, jobId } = await queueUpload(t); // no incoming file
		await t.services.worker.run();

		const failed = await revisionOf(t, revisionId);
		expect(failed.status).toBe("failed");
		expect(failed.rev).toBeNull();
		expect((await t.db.select().from(mapInfo).get())?.headRev).toBe(1);
		expect(await jobStatus(t, jobId)).toBe("failed");
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
		const { revisionId } = await queueUpload(t, { attempts: 1 }, "processing");
		await Bun.write(
			`${incomingDir(t.env, revisionId)}/0.png`,
			await solid(T, T, RED),
		);

		t.services.worker.start();
		t.services.worker.stop();
		await t.services.worker.run();

		expect((await revisionOf(t, revisionId)).status).toBe("done");
		expect(await readTile(t, 0, 0, 0)).not.toBeNull();
	});

	test("a job interrupted too many times is failed on start instead of retried", async () => {
		const t = await bootTiles();
		const { revisionId, jobId } = await queueUpload(
			t,
			{ attempts: 3 },
			"processing",
		);
		await Bun.write(
			`${incomingDir(t.env, revisionId)}/0.png`,
			await solid(T, T, RED),
		);

		t.services.worker.start();
		t.services.worker.stop();
		await t.services.worker.run();

		const rev = await revisionOf(t, revisionId);
		expect(rev).toMatchObject({
			status: "failed",
			error: "interrupted too many times",
		});
		expect(await jobStatus(t, jobId)).toBe("failed");
		expect(await readTile(t, 0, 0, 0)).toBeNull();
	});
});

describe("revision list", () => {
	test("filters by dimension and pages with before", async () => {
		const t = await bootTiles();
		const a = await upload(t, await solid(T, T, RED), 0, 0);
		const b = await upload(t, await solid(T, T, RED), 0, 0, t.editor, "nether");
		const c = await upload(t, await solid(T, T, BLUE), 0, 0);
		const ids = (body: { revisions: { id: number }[] }) =>
			body.revisions.map((r) => r.id);

		const over = await call(
			t,
			null,
			"GET",
			"/api/revisions?dimension=overworld",
		);
		expect(ids(over.body)).toEqual([c, a]);
		expect(over.body.nextBefore).toBeNull();
		const nether = await call(
			t,
			null,
			"GET",
			"/api/revisions?dimension=nether",
		);
		expect(ids(nether.body)).toEqual([b]);
		expect(
			(await call(t, null, "GET", "/api/revisions?dimension=nope")).status,
		).toBe(404);

		const first = await call(t, null, "GET", "/api/revisions?limit=2");
		expect(ids(first.body)).toEqual([c, b]);
		expect(first.body.nextBefore).toBe(b);
		const second = await call(
			t,
			null,
			"GET",
			`/api/revisions?limit=2&before=${first.body.nextBefore}`,
		);
		expect(ids(second.body)).toEqual([a]);
		expect(second.body.nextBefore).toBeNull();

		// Revisions asked for by id come along whatever the page.
		const withActive = await call(
			t,
			null,
			"GET",
			`/api/revisions?limit=1&active=${a}`,
		);
		expect(ids(withActive.body)).toEqual([c, a]);
	});
});

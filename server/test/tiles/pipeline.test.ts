import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { zipSync } from "fflate";

afterAll(cleanupTempDirs);

import { dimensions, jobs, revisions } from "../../src/db/schema";
import { processUpload } from "../../src/jobs/processUpload";
import { incomingDir } from "../../src/jobs/types";
import {
	BLUE,
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	GREEN,
	postUpload,
	px,
	RED,
	type Rgb,
	readTile,
	revisionOf,
	solid,
	T,
	type TileApp,
	upload,
	uploadFrom,
} from "../helpers";

const RED_PX = [255, 0, 0, 255];
const BLUE_PX = [0, 0, 255, 255];

const zeros = (n: number) => new Uint8Array(n);

describe("zip limits", () => {
	// Entries are only named like PNGs; the limits are checked before anything is inflated.
	const boot = (extra: Record<string, string> = {}) =>
		bootTiles({
			MAX_IMAGE_DIM: "64",
			MAX_UPLOAD_BYTES: "100000",
			...extra,
		});

	test("the expansion budget is shared by every zip of a request", async () => {
		const t = await boot();
		const zip = (name: string) =>
			zipSync({
				[`${name}a_x0_z0.png`]: zeros(80_000),
				[`${name}b_x16_z0.png`]: zeros(80_000),
			});
		// 160 000 bytes expanded each: fine alone (budget 200 000), too much together.
		const one = await postUpload(t, t.editor, [
			{ name: "one.zip", data: zip("1/") },
		]);
		expect(one.status).toBe(400); // not images, but within the limits
		const both = await postUpload(t, t.mod, [
			{ name: "one.zip", data: zip("1/") },
			{ name: "two.zip", data: zip("2/") },
		]);
		expect(both.status).toBe(413);
	});

	test("an entry too big to be an image of the allowed size is refused", async () => {
		const t = await boot();
		const res = await postUpload(t, t.editor, [
			{
				name: "big.zip",
				data: zipSync({ "a_x0_z0.png": zeros(90_000) }),
			},
		]);
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("too large");
	});

	test("the file count is limited before anything is expanded", async () => {
		const t = await boot({ MAX_FILES_PER_UPLOAD: "2" });
		const png = new Uint8Array(await solid(8, 8, RED));
		const res = await postUpload(t, t.editor, [
			{
				name: "many.zip",
				data: zipSync({
					"a_x0_z0.png": png,
					"b_x16_z0.png": png,
					"c_x32_z0.png": png,
				}),
			},
		]);
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("too many files");
	});

	test("files already sent count against the zip's file limit", async () => {
		const t = await boot({ MAX_FILES_PER_UPLOAD: "2" });
		const png = new Uint8Array(await solid(8, 8, RED));
		const res = await postUpload(t, t.editor, [
			{ name: "a_x0_z0.png", data: png },
			{
				name: "more.zip",
				data: zipSync({ "b_x16_z0.png": png, "c_x32_z0.png": png }),
			},
		]);
		expect(res.status).toBe(400);
	});
});

describe("storing an upload", () => {
	test("the revision, its job and its files appear together", async () => {
		const t = await bootTiles();
		const res = await postUpload(t, t.editor, [
			{ name: "a_x0_z0.png", data: await solid(T, T, RED) },
		]);
		const { revisionId } = (await res.json()) as { revisionId: number };
		const [job] = await t.db.select().from(jobs);
		expect(
			((job as typeof jobs.$inferSelect).payload as { revisionId: number })
				.revisionId,
		).toBe(revisionId);
		await t.services.worker.run();
		// Nothing is left behind once it is processed, not even the staging folder.
		expect(existsSync(incomingDir(t.env, revisionId))).toBe(false);
		expect(readdirSync(`${t.env.DATA_DIR}/incoming`)).toEqual([]);
	});
});

async function queueUpload(
	t: TileApp,
	data: Uint8Array,
	exportedAt: number | null,
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
			exportedAt,
		})
		.returning({ id: revisions.id });
	const revisionId = (rev as { id: number }).id;
	const files = [{ x: 0, z: 0, width: T, height: T }];
	const [job] = await t.db
		.insert(jobs)
		.values({ type: "process_upload", payload: { revisionId, files } })
		.returning({ id: jobs.id });
	await Bun.write(`${incomingDir(t.env, revisionId)}/0.png`, data);
	return { revisionId, jobId: (job as { id: number }).id, files };
}

const jobStatus = async (t: TileApp, id: number) =>
	(await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]?.status;

describe("publishing", () => {
	test("the job is done in the same transaction that publishes", async () => {
		const t = await bootTiles();
		const { revisionId, jobId } = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, RED)),
			null,
		);
		await t.services.worker.run();
		expect((await revisionOf(t, revisionId)).status).toBe("done");
		expect(await jobStatus(t, jobId)).toBe("done");
	});

	test("a failure after publishing does not fail the revision", async () => {
		const t = await bootTiles();
		const { revisionId, jobId } = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, RED)),
			null,
		);
		t.services.progress.subscribe(revisionId, (e) => {
			if (e.status === "done") throw new Error("listener broke");
		});
		await t.services.worker.run();
		expect(await revisionOf(t, revisionId)).toMatchObject({
			status: "done",
			error: null,
		});
		expect(await jobStatus(t, jobId)).toBe("done");
		expect(await readTile(t, 0, 0, 0)).not.toBeNull();
	});

	test("a published upload whose job was interrupted is not run again", async () => {
		const t = await bootTiles();
		const { revisionId, jobId } = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, RED)),
			null,
		);
		await t.services.worker.run();
		// As if the process died after publishing but before the job was marked.
		await t.db.update(jobs).set({ status: "processing" });
		t.services.worker.start();
		t.services.worker.stop();
		await t.services.worker.run();
		expect(await revisionOf(t, revisionId)).toMatchObject({
			status: "done",
			rev: 1,
			error: null,
		});
		expect(await jobStatus(t, jobId)).toBe("done");

		// And the same if it is still pending.
		await t.db.update(jobs).set({ status: "pending" });
		await t.services.worker.run();
		expect(await revisionOf(t, revisionId)).toMatchObject({
			status: "done",
			rev: 1,
		});
		expect(await jobStatus(t, jobId)).toBe("done");
	});

	test("unexpected errors are not shown to everyone, intended ones are", async () => {
		const t = await bootTiles();
		const { revisionId } = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, RED)),
			null,
		);
		await Bun.write(`${incomingDir(t.env, revisionId)}/0.png`, "not an image");
		await t.services.worker.run();
		const failed = await revisionOf(t, revisionId);
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("processing failed");
		expect(String(failed.error)).not.toContain(t.env.DATA_DIR);
	});

	test("an upload that was interrupted too many times loses its files", async () => {
		const t = await bootTiles();
		const { revisionId, jobId } = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, RED)),
			null,
		);
		await t.db
			.update(jobs)
			.set({ status: "processing", attempts: 3 })
			.where(eq(jobs.id, jobId));
		t.services.worker.start();
		t.services.worker.stop();
		expect(existsSync(incomingDir(t.env, revisionId))).toBe(false);
	});
});

describe("a delete waiting in the queue", () => {
	async function queueErase(t: TileApp, id: number) {
		await t.db
			.insert(jobs)
			.values({ type: "erase_upload", payload: { revisionId: id } });
	}

	test("leaves the upload as it is, and says it is being deleted", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		await queueErase(t, id);

		const rev = await revisionOf(t, id);
		expect(rev).toMatchObject({ status: "done", deleting: true });
		expect(rev.canDelete).toBe(false);
		const list = await call(t, t.mod, "GET", "/api/revisions");
		expect(list.body.revisions[0]).toMatchObject({ id, deleting: true });

		const again = await t.app.request(`/api/revisions/${id}`, {
			method: "DELETE",
			headers: t.mod.auth,
		});
		expect(again.status).toBe(409);

		const events = await t.app.request(`/api/revisions/${id}/events`);
		const reader = (events.body as ReadableStream).getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("event: processing");
		expect(first).toContain("Starting");
		await reader.cancel();

		await t.services.worker.run();
		expect((await t.app.request(`/api/revisions/${id}`)).status).toBe(404);
		expect(await readTile(t, 0, 0, 0)).toBeNull();
	});

	test("the route does not take the upload out of the map by itself", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const [first, second] = await Promise.all(
			[0, 1].map(() =>
				t.app.request(`/api/revisions/${id}`, {
					method: "DELETE",
					headers: t.mod.auth,
				}),
			),
		);
		expect([first?.status, second?.status].sort()).toEqual([202, 409]);
		await t.services.worker.run();
		expect((await t.app.request(`/api/revisions/${id}`)).status).toBe(404);
	});

	test("a failed erase can be tried again", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		await t.db
			.update(revisions)
			.set({ error: "delete failed: internal error" })
			.where(eq(revisions.id, id));
		await erase(t, id);
		expect((await t.app.request(`/api/revisions/${id}`)).status).toBe(404);
	});
});

describe("tile caching", () => {
	const base = "/api/dimensions/overworld/tiles/0/0/0";

	test("a pinned revision is only immutable under the current epoch", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const cache = async (q: string) =>
			(await t.app.request(`${base}${q}`)).headers.get("cache-control");
		expect(await cache("?rev=1&v=0")).toContain("immutable");
		expect(await cache("?rev=1")).toBe("public, max-age=60");
		expect(await cache("?rev=1&v=7")).toBe("public, max-age=60");
		expect(await cache("")).toBe("public, max-age=10");

		const other = await upload(t, await solid(T, T, BLUE), 16, 0);
		await erase(t, other);
		expect(await cache("?rev=1&v=0")).toBe("public, max-age=60");
		expect(await cache("?rev=1&v=1")).toContain("immutable");
	});

	test("an upload that is not done yet is not served on its own, or cached", async () => {
		const t = await bootTiles();
		const { revisionId } = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, RED)),
			null,
		);
		const res = await t.app.request(`${base}?only=${revisionId}`);
		expect(res.status).toBe(404);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const zoomed = await t.app.request(
			`/api/dimensions/overworld/tiles/1/0/0?only=${revisionId}`,
		);
		expect(zoomed.status).toBe(404);

		await t.services.worker.run();
		const done = await t.app.request(`${base}?only=${revisionId}&v=0`);
		expect(done.status).toBe(302);
		expect(done.headers.get("cache-control")).toContain("immutable");
		const zoomedDone = await t.app.request(
			`/api/dimensions/overworld/tiles/1/0/0?only=${revisionId}`,
		);
		expect(zoomedDone.status).toBe(200);
	});
});

describe("decoding sources once", () => {
	/** Overlapping files over a 3x3 block of tiles, later files on top. */
	async function overlapping(t: TileApp, batchBytes?: number) {
		const items = [
			{ data: await solid(2 * T + 4, 2 * T + 4, RED), x: 4, z: 4 },
			{ data: await solid(T + 8, 2 * T, BLUE), x: 2 * T, z: 8 },
			{ data: await solid(2 * T, T, GREEN), x: 0, z: 2 * T + 4 },
		];
		const dim = await t.db.query.dimensions.findFirst({
			where: eq(dimensions.slug, "overworld"),
		});
		const [rev] = await t.db
			.insert(revisions)
			.values({
				kind: "upload",
				dimensionId: (dim as { id: number }).id,
				authorId: "editor",
				fileCount: items.length,
			})
			.returning({ id: revisions.id });
		const revisionId = (rev as { id: number }).id;
		for (const [i, it] of items.entries()) {
			await Bun.write(`${incomingDir(t.env, revisionId)}/${i}.png`, it.data);
		}
		const files = await Promise.all(
			items.map(async (it) => {
				const { default: sharp } = await import("sharp");
				const m = await sharp(it.data).metadata();
				return {
					x: it.x,
					z: it.z,
					width: m.width as number,
					height: m.height as number,
				};
			}),
		);
		const [job] = await t.db
			.insert(jobs)
			.values({ type: "process_upload", payload: { revisionId, files } })
			.returning({ id: jobs.id });
		await processUpload(
			{
				db: t.db,
				env: t.env,
				blobs: t.services.blobs,
				progress: t.services.progress,
			},
			{ revisionId, files },
			(job as { id: number }).id,
			batchBytes,
		);
	}

	test("a small memory budget gives the same tiles as a large one", async () => {
		const whole = await bootTiles();
		const split = await bootTiles();
		await overlapping(whole);
		await overlapping(split, 1); // one tile per batch
		for (let zoom = 0; zoom <= 3; zoom++) {
			for (let y = 0; y <= 3; y++) {
				for (let x = 0; x <= 3; x++) {
					const a = await readTile(whole, zoom, x, y);
					const b = await readTile(split, zoom, x, y);
					expect(b === null ? null : [...b]).toEqual(
						a === null ? null : [...a],
					);
				}
			}
		}
		const tile = (await readTile(whole, 0, 2, 0)) as Buffer;
		expect(px(tile, 2, 12)).toEqual(BLUE_PX);
		expect(px((await readTile(whole, 0, 1, 1)) as Buffer, 5, 5)).toEqual(
			RED_PX,
		);
	});
});

describe("stacking order", () => {
	/** Uploads the same tile in the given order, in different colours; `skip` leaves one out. */
	async function build(order: string[], skip?: number) {
		const t = await bootTiles();
		const colors: Rgb[] = [RED, GREEN, BLUE, [255, 255, 0]];
		const ids: number[] = [];
		for (const [i, path] of order.entries()) {
			if (i === skip) continue;
			const data = await solid(T, T, colors[i] as Rgb);
			ids.push(await uploadFrom(t, data, 0, 0, path));
		}
		return { t, ids };
	}

	async function snapshot(t: TileApp, rev?: number) {
		const tile = await readTile(t, 0, 0, 0, rev);
		return tile === null ? null : [...tile];
	}

	test("erasing from a stack of out-of-order exports matches never having made it", async () => {
		const order = [
			"2026-02-10_10.00.00/a.png",
			"2026-02-12_10.00.00/a.png",
			"2026-02-11_10.00.00/a.png",
			"2026-02-13_10.00.00/a.png",
		];
		for (const skip of [0, 1, 2, 3]) {
			const full = await build(order);
			await erase(full.t, full.ids[skip] as number);
			const without = await build(order, skip);
			expect(await snapshot(full.t)).toEqual(await snapshot(without.t));
			for (let rev = 0; rev <= order.length; rev++) {
				const gap = skip + 1;
				if (rev === gap) continue;
				const there = rev < gap ? rev : rev - 1;
				expect(await snapshot(full.t, rev)).toEqual(
					await snapshot(without.t, there),
				);
			}
		}
	});

	test("with equal export times the later upload is on top, however jobs run", async () => {
		const t = await bootTiles();
		const at = Date.UTC(2026, 1, 10);
		// The job of the later upload (higher id) is queued, and so runs, first.
		const first = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, RED)),
			at,
		);
		const second = await queueUpload(
			t,
			new Uint8Array(await solid(T, T, BLUE)),
			at,
		);
		await t.db.delete(jobs);
		await t.db.insert(jobs).values([
			{
				type: "process_upload",
				payload: { revisionId: second.revisionId, files: second.files },
			},
			{
				type: "process_upload",
				payload: { revisionId: first.revisionId, files: first.files },
			},
		]);
		await t.services.worker.run();
		expect((await revisionOf(t, first.revisionId)).status).toBe("done");
		expect(px((await readTile(t, 0, 0, 0)) as Buffer, 3, 3)).toEqual(BLUE_PX);
	});
});

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb, runMigrations } from "../../src/db/client";
import {
	jobs,
	mapInfo,
	revisions,
	tileVersions,
	tileVersionsRebuild,
} from "../../src/db/schema";
import { messages, waitingMessage } from "../../src/jobs/messages";
import {
	queueRecompute,
	queueRecomputeIfPending,
} from "../../src/jobs/recomputeHistory";

afterAll(cleanupTempDirs);

import {
	BLACK,
	BLUE,
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	GREEN,
	makeTempDir,
	png,
	postUpload,
	RED,
	T,
	type TileApp,
	uploadMany,
} from "../helpers";

type Export = {
	name: string;
	path: string;
	dim: string;
	x: number;
	z: number;
	data: () => Promise<Buffer>;
};

/** Overlapping exports: partly black (no data), so the order they are stacked in matters. */
const EXPORTS: Record<string, Export> = {
	a: {
		name: "a",
		path: "2026-02-10_10.00.00/a.png",
		dim: "overworld",
		x: 0,
		z: 0,
		data: () => png(2 * T, T, () => RED),
	},
	b: {
		name: "b",
		path: "2026-02-12_10.00.00/b.png",
		dim: "overworld",
		x: 0,
		z: 0,
		data: () => png(T, T, (x) => (x < T / 2 ? BLACK : BLUE)),
	},
	c: {
		name: "c",
		path: "2026-02-11_10.00.00/c.png",
		dim: "overworld",
		x: 0,
		z: 0,
		data: () => png(2 * T, 2 * T, (_, y) => (y % 2 ? BLACK : GREEN)),
	},
	n: {
		name: "n",
		path: "2026-02-09_10.00.00/n.png",
		dim: "nether",
		x: 3 * T,
		z: -T,
		data: () => png(T, T, () => RED),
	},
};

async function build(names: string[]) {
	const t = await bootTiles({}, { owner: true });
	const ids: Record<string, number> = {};
	for (const name of names) {
		const e = EXPORTS[name] as Export;
		ids[name] = await uploadMany(
			t,
			[{ data: await e.data(), x: e.x, z: e.z, path: e.path }],
			t.editor,
			e.dim,
		);
	}
	return { t, ids };
}

const rows = (t: TileApp) =>
	t.db
		.select({
			dim: tileVersions.dimensionId,
			zoom: tileVersions.zoom,
			x: tileVersions.tileX,
			y: tileVersions.tileY,
			rev: tileVersions.rev,
			hash: tileVersions.blobHash,
		})
		.from(tileVersions)
		.orderBy(
			asc(tileVersions.dimensionId),
			asc(tileVersions.zoom),
			asc(tileVersions.tileX),
			asc(tileVersions.tileY),
			asc(tileVersions.rev),
		)
		.all();

const revOf = (t: TileApp, id: number) =>
	t.db
		.select({ rev: revisions.rev })
		.from(revisions)
		.where(eq(revisions.id, id))
		.get()?.rev;

const head = (t: TileApp) =>
	t.db.select().from(mapInfo).get() as typeof mapInfo.$inferSelect;

/** The newest rows of every tile: what the map looks like now. */
const latest = (t: TileApp) => {
	const out = new Map<string, string | null>();
	for (const r of rows(t)) out.set(`${r.dim}:${r.zoom}:${r.x},${r.y}`, r.hash);
	return out;
};

async function recompute(t: TileApp) {
	const res = await call(t, t.owner, "POST", "/api/admin/history/recompute");
	expect(res.status).toBe(202);
	await t.services.worker.run();
}

describe("recomputing history", () => {
	test("renumbers uploads by export date and rebuilds every revision as if uploaded in that order", async () => {
		const { t, ids } = await build(["a", "b", "n", "c"]);
		const ordered = await build(["n", "a", "c", "b"]);
		expect(rows(t)).not.toEqual(rows(ordered.t));
		const before = latest(t);
		const epoch = head(t).epoch;
		expect(
			(await call(t, t.owner, "GET", "/api/admin/history")).body,
		).toMatchObject({ lateUploads: 1, recompute: null });

		await recompute(t);

		// Export order across dimensions: n, a, c, b.
		expect(["n", "a", "c", "b"].map((k) => revOf(t, ids[k] as number))).toEqual(
			[1, 2, 3, 4],
		);
		expect(head(t)).toMatchObject({ headRev: 4, epoch: epoch + 1 });
		expect(rows(t)).toEqual(rows(ordered.t));
		expect(latest(t)).toEqual(before);
		expect(t.db.select().from(tileVersionsRebuild).all()).toEqual([]);

		const status = await call(t, t.owner, "GET", "/api/admin/history");
		expect(status.body).toMatchObject({
			lateUploads: 0,
			recompute: { status: "done", error: null, progress: null },
		});
	});

	test("changes nothing when history is already in order", async () => {
		const { t } = await build(["n", "a", "c", "b"]);
		const before = rows(t);
		await recompute(t);
		expect(rows(t)).toEqual(before);
	});

	test("uploads can be deleted afterwards", async () => {
		const { t, ids } = await build(["a", "b", "c"]);
		await recompute(t);
		await erase(t, ids.c as number);
		const without = await build(["a", "b"]);
		expect(latest(t)).toEqual(latest(without.t));
	});

	test("only owners, and one at a time", async () => {
		const { t } = await build(["a"]);
		for (const user of [t.editor, t.mod]) {
			expect((await call(t, user, "GET", "/api/admin/history")).status).toBe(
				403,
			);
			expect(
				(await call(t, user, "POST", "/api/admin/history/recompute")).status,
			).toBe(403);
		}
		expect(
			(await call(t, null, "POST", "/api/admin/history/recompute")).status,
		).toBe(401);

		const post = () => call(t, t.owner, "POST", "/api/admin/history/recompute");
		expect((await post()).status).toBe(202);
		expect((await post()).status).toBe(409);
		const queued = await call(t, t.owner, "GET", "/api/admin/history");
		expect(["pending", "processing"]).toContain(queued.body.recompute.status);
		await t.services.worker.run();
		expect((await post()).status).toBe(202);
		await t.services.worker.run();
	});

	test("a failed recompute leaves history as it was", async () => {
		const { t } = await build(["a", "b", "c"]);
		const before = rows(t);
		const { headRev, epoch } = head(t);
		// The patches can't be read any more.
		await rm(join(t.env.DATA_DIR, "blobs"), { recursive: true, force: true });
		await recompute(t);
		expect(rows(t)).toEqual(before);
		expect(head(t)).toMatchObject({ headRev, epoch });
		expect(t.db.select().from(tileVersionsRebuild).all()).toEqual([]);
		const status = await call(t, t.owner, "GET", "/api/admin/history");
		expect(status.body.recompute).toMatchObject({
			status: "failed",
			error: "internal error",
		});
	});

	test("an interrupted recompute starts over on boot", async () => {
		const { t } = await build(["a", "c"]);
		queueRecompute(t.db);
		t.db
			.update(jobs)
			.set({ status: "processing", attempts: 1 })
			.where(eq(jobs.type, "recompute_history"))
			.run();
		t.services.worker.start();
		t.services.worker.stop();
		await t.services.worker.run();
		const job = t.db
			.select()
			.from(jobs)
			.where(eq(jobs.type, "recompute_history"))
			.get();
		expect(job?.status).toBe("done");
	});

	test("the recompute a migration asks for is queued on boot", async () => {
		const { t, ids } = await build(["a", "c"]);
		expect(queueRecomputeIfPending(t.db)).toBe(false);
		t.db.update(mapInfo).set({ recomputePending: true }).run();
		expect(queueRecomputeIfPending(t.db)).toBe(true);
		expect(queueRecomputeIfPending(t.db)).toBe(false); // already queued
		await t.services.worker.run();
		expect(head(t).recomputePending).toBe(false);
		expect(revOf(t, ids.c as number)).toBe(2);
	});
});

describe("removing uploads reverted by old servers", () => {
	test("the migration deletes reverts, restores and hidden uploads, and asks for a recompute", () => {
		// A database as of the migration before.
		const dir = makeTempDir();
		const folder = join(dir, "migrations");
		const source = join(import.meta.dir, "../../src/db/migrations");
		cpSync(source, folder, { recursive: true });
		const journalPath = join(folder, "meta/_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
			entries: { tag: string }[];
		};
		const at = journal.entries.findIndex(
			(e) => e.tag === "0015_history_recompute",
		);
		expect(at).toBeGreaterThan(0);
		writeFileSync(
			journalPath,
			JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }),
		);
		const db = createDb(join(dir, "db.sqlite"));
		migrate(drizzle(db.$client), { migrationsFolder: folder });

		const sql = db.$client;
		sql.run(
			"INSERT INTO map_info (id, name, tile_size, head_rev, created_at) VALUES (1, 'm', 16, 4, 0)",
		);
		sql.run(
			"INSERT INTO users (id, username, created_at, last_login_at) VALUES ('u', 'u', 0, 0)",
		);
		sql.run(
			"INSERT INTO dimensions (id, slug, name, created_at) VALUES (1, 'overworld', 'Overworld', 0)",
		);
		const rev = (
			id: number,
			kind: string,
			r: number,
			target: number | null,
			reverted: number,
		) =>
			sql.run(
				"INSERT INTO revisions (id, rev, kind, dimension_id, author_id, target_revision_id, status, reverted, created_at) VALUES (?, ?, ?, 1, 'u', ?, 'done', ?, 0)",
				[id, r, kind, target, reverted],
			);
		rev(1, "upload", 1, null, 0);
		rev(2, "upload", 2, null, 1);
		rev(3, "revert", 3, 2, 0);
		rev(4, "unrevert", 4, 1, 0);
		for (const id of [1, 2])
			sql.run(
				"INSERT INTO upload_patches (revision_id, tile_x, tile_y, blob_hash) VALUES (?, 0, 0, 'h')",
				[id],
			);

		runMigrations(db);
		expect(
			db
				.select({ id: revisions.id })
				.from(revisions)
				.all()
				.map((r) => r.id),
		).toEqual([1]);
		expect(sql.query("SELECT revision_id FROM upload_patches").all()).toEqual([
			{ revision_id: 1 },
		]);
		expect(db.select().from(mapInfo).get()?.recomputePending).toBe(true);
		expect(queueRecomputeIfPending(db)).toBe(true);
	});

	test("a database without any leaves the flag off", () => {
		const db = createDb(join(makeTempDir(), "db.sqlite"));
		runMigrations(db);
		db.$client.run(
			"INSERT INTO map_info (id, name, tile_size, created_at) VALUES (1, 'm', 16, 0)",
		);
		expect(queueRecomputeIfPending(db)).toBe(false);
	});
});

describe("telling people what is going on", () => {
	test("progress messages read as sentences and say how far", async () => {
		const t = await bootTiles();
		const seen: { message?: string; done?: number; total?: number }[] = [];
		// The first revision of a new map is 1; the worker starts as soon as it is queued.
		t.services.progress.subscribe(1, (e) => seen.push(e));
		const res = await postUpload(t, t.editor, [
			{ name: "a_x0_z0.png", data: await png(T, T, () => RED) },
		]);
		expect(((await res.json()) as { revisionId: number }).revisionId).toBe(1);
		await t.services.worker.run();
		const said = seen.map((e) => e.message);
		expect(said).toContain(messages.starting);
		expect(said).toContain(messages.upload.reading);
		expect(said).toContain(messages.upload.tiles);
		expect(said).toContain(messages.upload.zoom(1));
		expect(said).toContain(messages.upload.publishing);
		const zoom = seen.filter((e) => e.message === messages.upload.zoom(1));
		expect(zoom.at(-1)?.done).toBe(zoom.at(-1)?.total);
	});

	test("a queued upload says what it waits for, and again when that changes", async () => {
		const { t } = await build(["a"]);
		await call(t, t.owner, "POST", "/api/admin/history/recompute");
		const res = await postUpload(t, t.editor, [
			{ name: "b_x0_z0.png", data: await png(T, T, () => BLUE) },
		]);
		const { revisionId } = (await res.json()) as { revisionId: number };

		const events = await t.app.request(`/api/revisions/${revisionId}/events`);
		const reader = (events.body as ReadableStream).getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("event: pending");
		expect(first).toContain("Waiting for the history recompute to finish");
		await reader.cancel();
		await t.services.worker.run();
	});

	test("what a job waits for", () => {
		expect(waitingMessage([])).toBe(messages.starting);
		expect(
			waitingMessage([{ type: "recompute_history", status: "processing" }]),
		).toBe("Waiting for the history recompute to finish");
		expect(
			waitingMessage([
				{ type: "process_upload", status: "processing" },
				{ type: "erase_upload", status: "pending" },
			]),
		).toContain("Waiting for 2 jobs ahead of it");
		expect(
			waitingMessage([{ type: "process_upload", status: "pending" }]),
		).toContain("Waiting for 1 job ahead of it");
	});
});

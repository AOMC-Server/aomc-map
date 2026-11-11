import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { featureRevisions, layers, revisions } from "../src/db/schema";
import { resetStatsCache } from "../src/routes/stats";
import { isModClient } from "../src/uploadClient";
import type { Auth, TileApp } from "./helpers";
import {
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	postUpload,
	RED,
	solid,
	T,
	upload,
} from "./helpers";

afterAll(cleanupTempDirs);

async function makeLayer(t: TileApp, user: Auth, body: object = {}) {
	const res = await call(t, user, "POST", "/api/layers", {
		dimension: "overworld",
		name: "Bases",
		color: "red",
		...body,
	});
	expect(res.status).toBe(201);
	return res.body.layer as { id: number };
}

async function addPin(t: TileApp, user: Auth, layerId: number) {
	const res = await call(t, user, "POST", `/api/layers/${layerId}/features`, {
		type: "pin",
		name: "Base",
		geometry: [1, 2],
	});
	expect(res.status).toBe(201);
	return res.body.feature as { id: number };
}

/** Asks for the figures as they are now: the shared part is normally reused for a minute. */
const stats = (t: TileApp, user: Auth, range?: string) => {
	resetStatsCache(t.db);
	return call(t, user, "GET", `/api/stats${range ? `?range=${range}` : ""}`);
};

const entry = (body: { leaderboard: { userId: string }[] }, id: string) =>
	body.leaderboard.find((r) => r.userId === id);

describe("stats", () => {
	test("counts uploads, tiles, area, features, edits and layers", async () => {
		const t = await bootTiles();
		// Two tiles, then one of them again: 3 tiles uploaded, 2 distinct.
		await upload(t, await solid(T * 2, T, RED), 0, 0);
		await upload(t, await solid(T, T, RED), 0, 0);

		const layer = await makeLayer(t, t.editor);
		const feature = await addPin(t, t.editor, layer.id);
		await addPin(t, t.mod, layer.id);
		const edited = await call(
			t,
			t.mod,
			"PATCH",
			`/api/features/${feature.id}`,
			{ name: "Renamed" },
		);
		expect(edited.status).toBe(200);

		const res = await stats(t, t.editor);
		expect(res.status).toBe(200);
		expect(res.body.range).toBe("all");
		expect(res.body.since).toBeNull();
		expect(res.body.me).toMatchObject({
			uploads: 2,
			tiles: 3,
			uploadedBlocks: 3 * T * T,
			areaTiles: 2,
			areaBlocks: 2 * T * T,
			featuresCreated: 1,
			featuresByType: { pin: 1, line: 0, polygon: 0 },
			featureEdits: 0,
			layersCreated: 1,
		});
		expect(entry(res.body, "editor")).toMatchObject({
			username: "editor",
			uploads: 2,
		});
		expect(entry(res.body, "mod")).toMatchObject({
			uploads: 0,
			featuresCreated: 1,
			featureEdits: 1,
			layersCreated: 0,
		});
		expect(res.body.totals).toMatchObject({
			uploads: 2,
			tiles: 3,
			uploadedBlocks: 3 * T * T,
			areaTiles: 2,
			featuresCreated: 2,
			featureEdits: 1,
			layersCreated: 1,
		});
	});

	test("the area history follows the export dates and starts from what was mapped before the range", async () => {
		const t = await bootTiles();
		const first = await upload(t, await solid(T, T, RED), 0, 0);
		await upload(t, await solid(T, T, RED), 0, 0); // the same tile again
		await upload(t, await solid(T, T, RED), T * 4, 0, t.mod);
		await t.db
			.update(revisions)
			.set({ exportedAt: Date.now() - 40 * 24 * 3600_000 })
			.where(eq(revisions.id, first));

		const all = await stats(t, t.editor);
		const last = all.body.areaHistory.at(-1);
		expect(last).toMatchObject({
			totalBlocks: 2 * T * T,
			myBlocks: T * T,
		});
		expect(last.totalBlocks).toBe(all.body.totals.areaBlocks);
		expect(last.myBlocks).toBe(all.body.me.areaBlocks);
		const values = all.body.areaHistory.map(
			(p: { totalBlocks: number }) => p.totalBlocks,
		);
		expect(values).toEqual([...values].sort((a, b) => a - b));

		const month = await stats(t, t.mod, "30d");
		expect(month.body.areaHistory[0]).toMatchObject({
			totalBlocks: T * T,
			myBlocks: 0,
		});
		expect(month.body.areaHistory.at(-1)).toMatchObject({
			totalBlocks: 2 * T * T,
			myBlocks: T * T,
		});

		const anon = await stats(t, null);
		expect(anon.body.areaHistory.at(-1).myBlocks).toBeNull();
		expect((await stats(await bootTiles(), null)).body.areaHistory).toEqual([]);
	});

	test("uploads from the AOMC Webmapper mod are counted separately, and still as uploads", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const send = async (agent: string | undefined, user = t.editor) => {
			const res = await postUpload(
				t,
				user,
				[{ name: "f.png", data: await solid(T, T, RED) }],
				{
					coords: [{ x: T * 8, z: 0 }],
					headers: agent ? { "User-Agent": agent } : {},
				},
			);
			expect(res.status).toBe(202);
			await t.services.worker.run();
			return ((await res.json()) as { revisionId: number }).revisionId;
		};
		const viaMod = await send("AOMC Webmapper/1.2.0 (Fabric 1.21)");
		await send("Mozilla/5.0 Firefox");
		await send("aomc-visited/0.9", t.mod); // the mod's older name

		const res = await stats(t, t.editor);
		expect(res.body.me).toMatchObject({
			uploads: 3,
			modUploads: 1,
			modUploadedBlocks: T * T,
			modAreaTiles: 1,
			modAreaBlocks: T * T,
			// The first, ordinary upload and the two at x = 8 tiles, one of them by the mod.
			tiles: 3,
			areaTiles: 2,
		});
		expect(entry(res.body, "editor")).toMatchObject({ modUploads: 1 });
		expect(entry(res.body, "mod")).toMatchObject({
			uploads: 1,
			modUploads: 1,
			modUploadedBlocks: T * T,
			modAreaBlocks: T * T,
		});
		// Both mod uploads covered the same tile: uploaded twice, mapped once.
		expect(res.body.totals).toMatchObject({
			uploads: 4,
			modUploads: 2,
			modUploadedBlocks: 2 * T * T,
			modAreaTiles: 1,
			modAreaBlocks: T * T,
			areaTiles: 2,
		});

		const revision = await call(t, null, "GET", `/api/revisions/${viaMod}`);
		expect(revision.body.revision.viaMod).toBe(true);
	});

	test("the mod is recognised by its User-Agent, as configured", async () => {
		const defaults = ["AOMC Webmapper", "AOMC Visited"];
		for (const agent of [
			"AOMC Webmapper/1.0",
			"aomc-webmapper",
			"AOMC_Visited 2.1 (Java 21)",
			"Java-http-client AOMCWebmapper/3",
		])
			expect(isModClient(agent, defaults)).toBe(true);
		for (const agent of [undefined, "", "Mozilla/5.0", "curl/8", "AOMC Map"])
			expect(isModClient(agent, defaults)).toBe(false);

		expect(isModClient("MyMod/2", ["mymod"])).toBe(true);
		expect(isModClient("Fabric MyMod 2.0", ["my*2"])).toBe(true);
		expect(isModClient("AOMC Webmapper", ["Other"])).toBe(false);
		// An empty or wildcard-only pattern must not match everything.
		expect(isModClient("anything", ["", "*", " "])).toBe(false);
		expect(isModClient("anything", [])).toBe(false);
	});

	test("MOD_USER_AGENTS changes what counts", async () => {
		const t = await bootTiles({ MOD_USER_AGENTS: "Custom Mod, Old Mod" });
		expect(t.env.MOD_USER_AGENTS).toEqual(["Custom Mod", "Old Mod"]);
		for (const agent of ["Custom Mod/1", "old-mod/3", "AOMC Webmapper/1"]) {
			const res = await postUpload(
				t,
				t.editor,
				[{ name: "f.png", data: await solid(T, T, RED) }],
				{ coords: [{ x: 0, z: 0 }], headers: { "User-Agent": agent } },
			);
			expect(res.status).toBe(202);
			await t.services.worker.run();
		}
		const res = await stats(t, t.editor);
		expect(res.body.me).toMatchObject({ uploads: 3, modUploads: 2 });
	});

	test("deleted and failed uploads are not counted", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		await upload(t, await solid(T, T, RED), T * 4, 0);
		await erase(t, id);
		await t.db.insert(revisions).values({
			kind: "upload",
			authorId: "editor",
			status: "failed",
			fileCount: 1,
		});
		const res = await stats(t, t.editor);
		expect(res.body.me).toMatchObject({ uploads: 1, tiles: 1 });
	});

	test("private layers count for their owner only", async () => {
		const t = await bootTiles();
		const secret = await makeLayer(t, t.editor, { visibility: "private" });
		await addPin(t, t.editor, secret.id);

		const own = await stats(t, t.editor);
		expect(own.body.me).toMatchObject({
			featuresCreated: 1,
			layersCreated: 1,
		});
		expect(entry(own.body, "editor")).toBeUndefined();
		expect(own.body.totals).toMatchObject({
			featuresCreated: 0,
			layersCreated: 0,
		});
		const anon = await stats(t, null);
		expect(anon.body.me).toBeNull();
		expect(anon.body.leaderboard).toEqual([]);
	});

	test("the range leaves out older activity", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t, t.editor);
		await addPin(t, t.editor, layer.id);
		await upload(t, await solid(T, T, RED), 0, 0);
		const old = Date.now() - 10 * 24 * 3600_000;
		await t.db.update(featureRevisions).set({ createdAt: old });
		await t.db
			.update(layers)
			.set({ createdAt: old })
			.where(eq(layers.id, layer.id));

		const week = await stats(t, t.editor, "7d");
		expect(week.body.since).toBeGreaterThan(Date.now() - 8 * 24 * 3600_000);
		expect(week.body.me).toMatchObject({
			uploads: 1,
			featuresCreated: 0,
			layersCreated: 0,
		});
		const month = await stats(t, t.editor, "30d");
		expect(month.body.me).toMatchObject({
			featuresCreated: 1,
			layersCreated: 1,
		});
		expect((await stats(t, null, "1y")).status).toBe(400);
	});

	test("what is the same for everyone is reused for a minute, your own figures are not", async () => {
		const t = await bootTiles();
		const get = () => call(t, t.editor, "GET", "/api/stats");
		const before = await get();
		expect(before.body.totals.layersCreated).toBe(0);

		await makeLayer(t, t.editor);
		await upload(t, await solid(T, T, RED), 0, 0);
		const cached = await get();
		expect(cached.body.me).toMatchObject({ layersCreated: 1 });
		expect(cached.body.totals).toEqual(before.body.totals);
		expect(cached.body.leaderboard).toEqual(before.body.leaderboard);

		resetStatsCache(t.db);
		const fresh = await get();
		expect(fresh.body.totals).toMatchObject({ layersCreated: 1, uploads: 1 });
		expect(entry(fresh.body, "editor")).toMatchObject({ uploads: 1 });
	});

	test("the area history dates an upload by its export, else by when it was uploaded", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const tenDays = 10 * 24 * 3600_000;
		// Uploaded 10 days ago but finished only yesterday: it still counts as 10 days old.
		await t.db
			.update(revisions)
			.set({
				createdAt: Date.now() - tenDays,
				completedAt: Date.now() - 24 * 3600_000,
				exportedAt: null,
			})
			.where(eq(revisions.id, id));
		const week = await stats(t, null, "7d");
		expect(week.body.areaHistory[0]).toMatchObject({
			totalBlocks: T * T,
		});
	});
});

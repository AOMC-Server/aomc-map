import { afterAll, describe, expect, test } from "bun:test";
import { featureInputSchema } from "@aomc/shared";
import { eq } from "drizzle-orm";
import {
	featureRevisions,
	layerMembers,
	layers,
	revisions,
} from "../src/db/schema";
import type { Auth, TileApp } from "./helpers";
import {
	bootTiles,
	call,
	cleanupTempDirs,
	makeUser,
	RED,
	solid,
	T,
	upload,
} from "./helpers";

afterAll(cleanupTempDirs);

const pin = (x = 10, z = 20, extra: object = {}) => ({
	type: "pin",
	name: "Base",
	geometry: [x, z],
	...extra,
});

async function makeLayer(t: TileApp, user: Auth = t.editor, body: object = {}) {
	const res = await call(t, user, "POST", "/api/layers", {
		dimension: "overworld",
		name: "Bases",
		color: "red",
		...body,
	});
	expect(res.status).toBe(201);
	return res.body.layer as { id: number };
}

describe("layers", () => {
	test("create and list with features; defaults applied", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const created = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/features`,
			pin(),
		);
		expect(created.status).toBe(201);
		expect(created.body.feature).toMatchObject({
			type: "pin",
			name: "Base",
			popup: "",
			color: null,
			geometry: [10, 20],
			authorId: "editor",
		});

		const list = await call(t, null, "GET", "/api/layers?dim=overworld");
		expect(list.status).toBe(200);
		expect(list.body.layers).toHaveLength(1);
		expect(list.body.layers[0]).toMatchObject({
			name: "Bases",
			color: "red",
			hiddenByDefault: false,
			visibility: "public",
			canEdit: false,
		});
		expect(list.body.layers[0].features).toHaveLength(1);
		const asEditor = await call(t, t.editor, "GET", "/api/layers");
		expect(asEditor.body.layers[0].canEdit).toBe(true);
	});

	test("filters by dimension and rejects unknown dimensions or a bad `at`", async () => {
		const t = await bootTiles();
		await makeLayer(t);
		await makeLayer(t, t.editor, { dimension: "nether", name: "Hell" });
		const nether = await call(t, null, "GET", "/api/layers?dim=nether");
		expect(nether.body.layers.map((l: { name: string }) => l.name)).toEqual([
			"Hell",
		]);
		const all = await call(t, null, "GET", "/api/layers");
		expect(all.body.layers).toHaveLength(2);
		expect((await call(t, null, "GET", "/api/layers?dim=nope")).status).toBe(
			404,
		);
		expect((await call(t, null, "GET", "/api/layers?at=x")).status).toBe(400);
	});

	test("requires login; validates input", async () => {
		const t = await bootTiles();
		const body = { dimension: "overworld", name: "L", color: "red" };
		expect((await call(t, null, "POST", "/api/layers", body)).status).toBe(401);

		expect(
			(
				await call(t, t.editor, "POST", "/api/layers", {
					...body,
					color: "teal",
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(t, t.editor, "POST", "/api/layers", {
					...body,
					name: "",
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(t, t.editor, "POST", "/api/layers", {
					...body,
					dimension: "nope",
				})
			).status,
		).toBe(404);
	});

	test("update: editors may edit, anyone-but-owner-or-moderator may not change visibility", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const other = await makeUser(t.db, "other");

		const renamed = await call(t, other, "PATCH", `/api/layers/${layer.id}`, {
			name: "Renamed",
			hiddenByDefault: true,
		});
		expect(renamed.status).toBe(200);
		expect(renamed.body.layer).toMatchObject({
			name: "Renamed",
			hiddenByDefault: true,
		});
		expect(
			(
				await call(t, other, "PATCH", `/api/layers/${layer.id}`, {
					visibility: "private",
				})
			).status,
		).toBe(403);
		expect(
			(
				await call(t, t.editor, "PATCH", `/api/layers/${layer.id}`, {
					visibility: "private",
				})
			).status,
		).toBe(200);
		// A private layer is invisible to someone who isn't a member.
		expect(
			(await call(t, other, "PATCH", `/api/layers/${layer.id}`, { name: "x" }))
				.status,
		).toBe(404);
	});

	test("soft delete: creator or moderator, and the layer disappears", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const other = await makeUser(t.db, "other");
		expect(
			(await call(t, other, "DELETE", `/api/layers/${layer.id}`)).status,
		).toBe(403);
		expect(
			(await call(t, null, "DELETE", `/api/layers/${layer.id}`)).status,
		).toBe(401);
		expect(
			(await call(t, t.mod, "DELETE", `/api/layers/${layer.id}`)).status,
		).toBe(200);
		expect(
			(await call(t, null, "GET", "/api/layers")).body.layers,
		).toHaveLength(0);
		expect(
			(await call(t, t.editor, "DELETE", `/api/layers/${layer.id}`)).status,
		).toBe(404);
		const [row] = await t.db
			.select()
			.from(layers)
			.where(eq(layers.id, layer.id));
		expect(row?.deletedAt).not.toBeNull();

		const mine = await makeLayer(t);
		expect(
			(await call(t, t.editor, "DELETE", `/api/layers/${mine.id}`)).status,
		).toBe(200);
	});
});

describe("feature validation", () => {
	const line = [
		[0, 0],
		[5, 5],
	];
	const triangle = [
		[0, 0],
		[5, 0],
		[5, 5],
	];
	const cases: [string, object, boolean][] = [
		["pin", pin(), true],
		["pin with two points", { ...pin(), geometry: line }, false],
		["line", { type: "line", name: "x", geometry: line }, true],
		[
			"line with one point",
			{ type: "line", name: "x", geometry: [[0, 0]] },
			false,
		],
		["polygon", { type: "polygon", name: "x", geometry: triangle }, true],
		[
			"polygon with two points",
			{ type: "polygon", name: "x", geometry: line },
			false,
		],
		["fractional coordinate", pin(1.5, 2), false],
		["coordinate out of range", pin(30_000_001, 0), false],
		["extreme valid coordinate", pin(-30_000_000, 30_000_000), true],
		["name too long", pin(1, 1, { name: "x".repeat(101) }), false],
		["name at the limit", pin(1, 1, { name: "x".repeat(100) }), true],
		["popup too long", pin(1, 1, { popup: "x".repeat(2001) }), false],
		["popup at the limit", pin(1, 1, { popup: "x".repeat(2000) }), true],
		["unknown colour", pin(1, 1, { color: "chartreuse" }), false],
		["colour override", pin(1, 1, { color: "lime" }), true],
		["unknown type", { type: "circle", name: "x", geometry: [0, 0] }, false],
		["missing geometry", { type: "pin", name: "x" }, false],
	];
	for (const [name, body, valid] of cases) {
		test(name, () => {
			expect(featureInputSchema.safeParse(body).success).toBe(valid);
		});
	}

	test("defaults are applied", () => {
		expect(
			featureInputSchema.parse({ type: "pin", name: "x", geometry: [1, 2] }),
		).toEqual({
			type: "pin",
			name: "x",
			geometry: [1, 2],
			popup: "",
			color: null,
		});
	});

	test("the API answers 400 for an invalid body and 201 for a valid one", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const post = (body: object) =>
			call(t, t.editor, "POST", `/api/layers/${layer.id}/features`, body);
		expect((await post({ ...pin(), geometry: [1.5, 2] })).status).toBe(400);
		expect((await post(pin())).status).toBe(201);
	});

	test("popups are stored verbatim (rendering is the client's job) and never interpreted", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const popup = "<img src=x onerror=alert(1)> **bold**";
		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/features`,
			pin(1, 1, { popup }),
		);
		expect(res.body.feature.popup).toBe(popup);
	});
});

describe("feature revisions", () => {
	async function setup() {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/features`,
			pin(),
		);
		return { t, layer, feature: res.body.feature as { id: number } };
	}

	test("patch adds a revision, merging unspecified fields", async () => {
		const { t, feature } = await setup();
		const res = await call(
			t,
			t.editor,
			"PATCH",
			`/api/features/${feature.id}`,
			{ name: "Renamed", color: "blue" },
		);
		expect(res.status).toBe(200);
		expect(res.body.feature).toMatchObject({
			name: "Renamed",
			color: "blue",
			geometry: [10, 20],
			type: "pin",
		});
		const revs = await t.db
			.select()
			.from(featureRevisions)
			.where(eq(featureRevisions.featureId, feature.id));
		expect(revs).toHaveLength(2);

		const cleared = await call(
			t,
			t.editor,
			"PATCH",
			`/api/features/${feature.id}`,
			{ color: null },
		);
		expect(cleared.body.feature.color).toBeNull();
	});

	test("patch is validated after merging", async () => {
		const { t, feature } = await setup();
		expect(
			(
				await call(t, t.editor, "PATCH", `/api/features/${feature.id}`, {
					type: "line",
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(t, t.editor, "PATCH", `/api/features/${feature.id}`, {
					geometry: [[1, 2]],
				})
			).status,
		).toBe(400);
		const ok = await call(t, t.editor, "PATCH", `/api/features/${feature.id}`, {
			type: "line",
			geometry: [
				[0, 0],
				[9, 9],
			],
		});
		expect(ok.status).toBe(200);
		expect(ok.body.feature.type).toBe("line");
	});

	test("delete hides the feature but keeps its history", async () => {
		const { t, feature } = await setup();
		expect(
			(await call(t, t.editor, "DELETE", `/api/features/${feature.id}`)).status,
		).toBe(200);
		const list = await call(t, null, "GET", "/api/layers");
		expect(list.body.layers[0].features).toHaveLength(0);
		expect(
			(await call(t, t.editor, "DELETE", `/api/features/${feature.id}`)).status,
		).toBe(404);
		expect(
			(
				await call(t, t.editor, "PATCH", `/api/features/${feature.id}`, {
					name: "x",
				})
			).status,
		).toBe(404);

		const history = await call(
			t,
			null,
			"GET",
			`/api/features/${feature.id}/history`,
		);
		expect(
			history.body.history.map((h: { deleted: boolean }) => h.deleted),
		).toEqual([true, false]);
		expect(history.body.history[0].authorName).toBe("editor");
	});

	test("restore copies an old revision as a new one (moderator only)", async () => {
		const { t, feature } = await setup();
		await call(t, t.editor, "PATCH", `/api/features/${feature.id}`, {
			name: "Vandalised",
			geometry: [999, 999],
		});
		const history = (
			await call(t, null, "GET", `/api/features/${feature.id}/history`)
		).body.history;
		const original = history[history.length - 1].revisionId;

		expect(
			(
				await call(
					t,
					t.editor,
					"POST",
					`/api/features/${feature.id}/restore/${original}`,
				)
			).status,
		).toBe(403);
		const restored = await call(
			t,
			t.mod,
			"POST",
			`/api/features/${feature.id}/restore/${original}`,
		);
		expect(restored.status).toBe(201);
		expect(restored.body.feature).toMatchObject({
			name: "Base",
			geometry: [10, 20],
			authorId: "mod",
		});
		const after = (
			await call(t, null, "GET", `/api/features/${feature.id}/history`)
		).body.history;
		expect(after).toHaveLength(3);
		expect(
			(
				await call(
					t,
					t.mod,
					"POST",
					`/api/features/${feature.id}/restore/999999`,
				)
			).status,
		).toBe(404);
	});

	test("restoring a revision from before a delete brings the feature back", async () => {
		const { t, feature } = await setup();
		await call(t, t.editor, "DELETE", `/api/features/${feature.id}`);
		const history = (
			await call(t, null, "GET", `/api/features/${feature.id}/history`)
		).body.history;
		const before = history[history.length - 1].revisionId;
		await call(
			t,
			t.mod,
			"POST",
			`/api/features/${feature.id}/restore/${before}`,
		);
		const list = await call(t, null, "GET", "/api/layers");
		expect(list.body.layers[0].features).toHaveLength(1);
	});

	test("anonymous cannot write; unknown ids are 404", async () => {
		const { t, feature } = await setup();
		expect(
			(
				await call(t, null, "PATCH", `/api/features/${feature.id}`, {
					name: "x",
				})
			).status,
		).toBe(401);
		expect(
			(await call(t, null, "DELETE", `/api/features/${feature.id}`)).status,
		).toBe(401);
		expect(
			(await call(t, t.editor, "PATCH", "/api/features/9999", { name: "x" }))
				.status,
		).toBe(404);
		expect(
			(await call(t, t.editor, "PATCH", "/api/features/abc", { name: "x" }))
				.status,
		).toBe(404);
	});
});

describe("time travel", () => {
	test("`at` shows features and layers as they were when that revision completed", async () => {
		const t = await bootTiles();
		for (let i = 0; i < 3; i++)
			await upload(t, await solid(T, T, RED), i * T, 0);
		const stamps = [1000, 3000, 5000];
		for (const [i, completedAt] of stamps.entries()) {
			await t.db
				.update(revisions)
				.set({ completedAt })
				.where(eq(revisions.rev, i + 1));
		}

		const layer = await makeLayer(t);
		const created = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/features`,
			pin(),
		);
		const id = created.body.feature.id as number;
		await t.db.update(layers).set({ createdAt: 500 });
		await t.db
			.update(featureRevisions)
			.set({ createdAt: 2000 })
			.where(eq(featureRevisions.featureId, id));
		const edit = await call(t, t.editor, "PATCH", `/api/features/${id}`, {
			name: "Edited",
		});
		await t.db
			.update(featureRevisions)
			.set({ createdAt: 4000 })
			.where(eq(featureRevisions.id, edit.body.feature.revisionId));

		const at = async (rev: number) =>
			(await call(t, null, "GET", `/api/layers?dim=overworld&at=${rev}`)).body
				.layers[0]?.features ?? [];
		expect(await at(1)).toHaveLength(0);
		expect((await at(2))[0].name).toBe("Base");
		expect((await at(3))[0].name).toBe("Edited");
		expect((await at(99))[0].name).toBe("Edited");
		const head = (await call(t, null, "GET", "/api/layers")).body.layers[0]
			.features;
		expect(head[0].name).toBe("Edited");

		// Deleting the feature (at t=6000) leaves older revisions intact.
		const del = await call(t, t.editor, "DELETE", `/api/features/${id}`);
		expect(del.status).toBe(200);
		await t.db
			.update(featureRevisions)
			.set({ createdAt: 6000 })
			.where(eq(featureRevisions.deleted, true));
		await t.db
			.update(revisions)
			.set({ completedAt: 7000 })
			.where(eq(revisions.rev, 3));
		expect((await at(2))[0].name).toBe("Base");
	});

	test("layers created later or deleted earlier are excluded", async () => {
		const t = await bootTiles();
		for (let i = 0; i < 3; i++)
			await upload(t, await solid(T, T, RED), i * T, 0);
		for (const [i, completedAt] of [1000, 3000, 5000].entries()) {
			await t.db
				.update(revisions)
				.set({ completedAt })
				.where(eq(revisions.rev, i + 1));
		}
		const young = await makeLayer(t, t.editor, { name: "Young" });
		const old = await makeLayer(t, t.editor, { name: "Old" });
		await t.db
			.update(layers)
			.set({ createdAt: 4000 })
			.where(eq(layers.id, young.id));
		await t.db
			.update(layers)
			.set({ createdAt: 100, deletedAt: 2000 })
			.where(eq(layers.id, old.id));
		const names = async (rev: number) =>
			(await call(t, null, "GET", `/api/layers?at=${rev}`)).body.layers.map(
				(l: { name: string }) => l.name,
			);
		expect(await names(1)).toEqual(["Old"]);
		expect(await names(2)).toEqual([]);
		expect(await names(3)).toEqual(["Young"]);
	});
});

describe("private layers", () => {
	async function setup() {
		const t = await bootTiles();
		const layer = await makeLayer(t, t.editor, {
			visibility: "private",
			name: "Secret",
		});
		await call(t, t.editor, "POST", `/api/layers/${layer.id}/features`, pin());
		const stranger = await makeUser(t.db, "stranger");
		const viewer = await makeUser(t.db, "viewer");
		await t.db
			.insert(layerMembers)
			.values({ layerId: layer.id, userId: "viewer", role: "viewer" });
		return { t, layer, stranger, viewer };
	}
	const names = async (t: TileApp, user: Auth) =>
		(await call(t, user, "GET", "/api/layers")).body.layers.map(
			(l: { name: string }) => l.name,
		);

	test("listed for the creator, layer members and moderators only", async () => {
		const { t, stranger, viewer } = await setup();
		expect(await names(t, t.editor)).toEqual(["Secret"]);
		expect(await names(t, t.mod)).toEqual(["Secret"]);
		expect(await names(t, viewer)).toEqual(["Secret"]);
		expect(await names(t, stranger)).toEqual([]);
		expect(await names(t, null)).toEqual([]);
	});

	test("hidden from everyone else with 404, features included", async () => {
		const { t, layer, stranger } = await setup();
		for (const user of [null, stranger]) {
			expect(
				(await call(t, user, "GET", `/api/layers/${layer.id}/export`)).status,
			).toBe(404);
		}
		expect(
			(
				await call(
					t,
					stranger,
					"POST",
					`/api/layers/${layer.id}/features`,
					pin(),
				)
			).status,
		).toBe(404);
		expect(
			(await call(t, stranger, "DELETE", `/api/layers/${layer.id}`)).status,
		).toBe(404);
		expect(
			(await call(t, stranger, "GET", "/api/features/1/history")).status,
		).toBe(404);
		expect(
			(await call(t, stranger, "PATCH", "/api/features/1", { name: "x" }))
				.status,
		).toBe(404);
	});

	test("a layer viewer can read but not edit; a moderator can edit without membership", async () => {
		const { t, layer, viewer } = await setup();
		expect(
			(await call(t, viewer, "GET", `/api/layers/${layer.id}/export`)).status,
		).toBe(200);
		expect(
			(await call(t, viewer, "POST", `/api/layers/${layer.id}/features`, pin()))
				.status,
		).toBe(403);
		expect(
			(await call(t, t.mod, "POST", `/api/layers/${layer.id}/features`, pin()))
				.status,
		).toBe(201);
	});

	test("private layers hide their features from time travel reads too", async () => {
		const { t, stranger } = await setup();
		const res = await call(t, stranger, "GET", "/api/layers?at=0");
		expect(res.body.layers).toEqual([]);
	});
});

describe("export and import", () => {
	test("round trips; replace swaps the contents; large imports are rejected", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const items = [
			pin(1, 2, { popup: "hello", color: "lime" }),
			{
				type: "line",
				name: "Road",
				popup: "",
				color: null,
				geometry: [
					[0, 0],
					[100, 100],
				],
			},
		];
		const imported = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/import`,
			items,
		);
		expect(imported.status).toBe(201);
		expect(imported.body).toEqual({ imported: 2, replaced: 0 });

		const exported = await call(
			t,
			null,
			"GET",
			`/api/layers/${layer.id}/export`,
		);
		expect(exported.headers.get("content-disposition")).toContain("attachment");
		expect(exported.body).toEqual([
			{
				type: "pin",
				name: "Base",
				popup: "hello",
				color: "lime",
				geometry: [1, 2],
			},
			{
				type: "line",
				name: "Road",
				popup: "",
				color: null,
				geometry: [
					[0, 0],
					[100, 100],
				],
			},
		]);

		const appended = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/import`,
			[pin(5, 5)],
		);
		expect(appended.status).toBe(201);
		expect(
			(await call(t, null, "GET", `/api/layers/${layer.id}/export`)).body,
		).toHaveLength(3);

		const firstId = (await call(t, null, "GET", "/api/layers")).body.layers[0]
			.features[0].id as number;
		const replaced = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/import?replace=1`,
			[pin(9, 9)],
		);
		expect(replaced.body).toEqual({ imported: 1, replaced: 3 });
		const after = (await call(t, null, "GET", `/api/layers/${layer.id}/export`))
			.body;
		expect(after).toHaveLength(1);
		expect(after[0].geometry).toEqual([9, 9]);

		// Old data is still in history.
		const history = await call(
			t,
			null,
			"GET",
			`/api/features/${firstId}/history`,
		);
		expect(
			history.body.history.map((h: { deleted: boolean }) => h.deleted),
		).toEqual([true, false]);
	});

	test("an invalid item rejects the whole import; permissions apply", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const bad = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/import`,
			[pin(), { type: "pin", name: "x", geometry: [1] }],
		);
		expect(bad.status).toBe(400);
		expect(
			(await call(t, null, "GET", `/api/layers/${layer.id}/export`)).body,
		).toEqual([]);
		expect(
			(await call(t, null, "POST", `/api/layers/${layer.id}/import`, [pin()]))
				.status,
		).toBe(401);
	});

	test("a layer holds at most 5000 features", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const many = Array.from({ length: 5000 }, (_, i) => pin(i, i));
		expect(
			(await call(t, t.editor, "POST", `/api/layers/${layer.id}/import`, many))
				.status,
		).toBe(201);
		expect(
			(
				await call(t, t.editor, "POST", `/api/layers/${layer.id}/import`, [
					pin(),
				])
			).status,
		).toBe(409);
		expect(
			(
				await call(
					t,
					t.editor,
					"POST",
					`/api/layers/${layer.id}/features`,
					pin(),
				)
			).status,
		).toBe(409);
		const tooMany = [...many, pin()];
		expect(
			(
				await call(
					t,
					t.editor,
					"POST",
					`/api/layers/${layer.id}/import?replace=1`,
					tooMany,
				)
			).status,
		).toBe(400);
		expect(
			(
				await call(
					t,
					t.editor,
					"POST",
					`/api/layers/${layer.id}/import?replace=1`,
					many,
				)
			).status,
		).toBe(201);
	});
});

import { afterAll, describe, expect, test } from "bun:test";
import { featureInputSchema, MAX_LAYERS_PER_USER } from "@aomc/shared";
import { eq } from "drizzle-orm";
import {
	featureRevisions,
	features,
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
		[
			"closed line",
			{ type: "line", name: "x", geometry: [...triangle, [0, 0]] },
			true,
		],
		[
			"branching line",
			{
				type: "line",
				name: "x",
				geometry: [
					line,
					[
						[5, 5],
						[9, 0],
					],
				],
			},
			true,
		],
		[
			"line with a one-point path",
			{ type: "line", name: "x", geometry: [line, [[5, 5]]] },
			false,
		],
		["line with no paths", { type: "line", name: "x", geometry: [] }, false],
		[
			"line with too many points across its paths",
			{
				type: "line",
				name: "x",
				geometry: Array.from({ length: 1001 }, () => line),
			},
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

describe("reordering", () => {
	const ids = (body: { features: { id: number }[] } | { id: number }[]) =>
		(Array.isArray(body) ? body : body.features).map((f) => f.id);

	async function listLayer(t: TileApp, layerId: number) {
		const res = await call(t, t.editor, "GET", "/api/layers?dim=overworld");
		return (
			res.body.layers as { id: number; features: { id: number }[] }[]
		).find((l) => l.id === layerId);
	}

	test("features are listed in the new order, and new ones go last", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const add = async (x: number) =>
			(
				await call(
					t,
					t.editor,
					"POST",
					`/api/layers/${layer.id}/features`,
					pin(x),
				)
			).body.feature.id as number;
		const [a, b, c] = [await add(1), await add(2), await add(3)];
		expect(ids((await listLayer(t, layer.id)) as never)).toEqual([a, b, c]);

		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/features/reorder`,
			{ ids: [c, a, b] },
		);
		expect(res.status).toBe(200);
		const d = await add(4);
		expect(ids((await listLayer(t, layer.id)) as never)).toEqual([c, a, b, d]);
	});

	test("the list must be exactly the layer's features; viewers and anonymous users may not reorder", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const post = (body: object, user: Auth = t.editor) =>
			call(t, user, "POST", `/api/layers/${layer.id}/features/reorder`, body);
		const a = (
			await call(
				t,
				t.editor,
				"POST",
				`/api/layers/${layer.id}/features`,
				pin(1),
			)
		).body.feature.id as number;
		const b = (
			await call(
				t,
				t.editor,
				"POST",
				`/api/layers/${layer.id}/features`,
				pin(2),
			)
		).body.feature.id as number;
		expect((await post({ ids: [a] })).status).toBe(409);
		expect((await post({ ids: [a, a] })).status).toBe(409);
		expect((await post({ ids: [a, b, 999] })).status).toBe(409);
		expect((await post({ ids: "nope" })).status).toBe(400);
		expect((await post({ ids: [b, a] }, null)).status).toBe(401);

		// A deleted feature is not part of the list.
		await call(t, t.editor, "DELETE", `/api/features/${a}`);
		expect((await post({ ids: [b] })).status).toBe(200);
	});

	test("layers are listed in the new order, per dimension", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, { name: "A" });
		const b = await makeLayer(t, t.editor, { name: "B" });
		const c = await makeLayer(t, t.editor, { name: "C" });
		const order = async () =>
			(
				(await call(t, t.editor, "GET", "/api/layers?dim=overworld")).body
					.layers as { name: string }[]
			).map((l) => l.name);
		expect(await order()).toEqual(["A", "B", "C"]);

		const res = await call(t, t.editor, "POST", "/api/layers/reorder", {
			dimension: "overworld",
			ids: [c.id, a.id, b.id],
		});
		expect(res.status).toBe(200);
		expect(await order()).toEqual(["C", "A", "B"]);

		const bad = (body: object, user: Auth = t.editor) =>
			call(t, user, "POST", "/api/layers/reorder", body);
		expect((await bad({ dimension: "overworld", ids: [a.id] })).status).toBe(
			409,
		);
		expect((await bad({ dimension: "nowhere", ids: [] })).status).toBe(404);
		expect(
			(await bad({ dimension: "overworld", ids: [a.id, b.id, c.id] }, null))
				.status,
		).toBe(401);
	});

	test("a private layer someone cannot see keeps its place when they reorder", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, { name: "A" });
		await makeLayer(t, t.editor, { name: "Secret", visibility: "private" });
		const c = await makeLayer(t, t.editor, { name: "C" });
		const namesFor = async (user: Auth) =>
			(
				(await call(t, user, "GET", "/api/layers?dim=overworld")).body
					.layers as { name: string }[]
			).map((l) => l.name);
		expect(await namesFor(t.mod)).toEqual(["A", "Secret", "C"]);

		// Another editor does not see "Secret", so they send only A and C.
		const other = await makeUser(t.db, "other");
		expect(await namesFor(other)).toEqual(["A", "C"]);
		const res = await call(t, other, "POST", "/api/layers/reorder", {
			dimension: "overworld",
			ids: [c.id, a.id],
		});
		expect(res.status).toBe(200);
		expect(await namesFor(other)).toEqual(["C", "A"]);
		expect(await namesFor(t.mod)).toEqual(["C", "Secret", "A"]);

		// A moderator sees every layer, so a list without "Secret" is out of date for them.
		const incomplete = await call(t, t.mod, "POST", "/api/layers/reorder", {
			dimension: "overworld",
			ids: [a.id, c.id],
		});
		expect(incomplete.status).toBe(409);
	});
});

describe("concurrent edits", () => {
	async function addPin(t: TileApp, layerId: number) {
		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layerId}/features`,
			pin(),
		);
		expect(res.status).toBe(201);
		return res.body.feature as { id: number; revisionId: number };
	}
	const revisionCount = async (t: TileApp, featureId: number) =>
		(
			await t.db
				.select()
				.from(featureRevisions)
				.where(eq(featureRevisions.featureId, featureId))
		).length;

	test("an update based on an older revision answers 409 with the current feature", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const feature = await addPin(t, layer.id);
		const url = `/api/features/${feature.id}`;

		const first = await call(t, t.editor, "PATCH", url, {
			name: "One",
			baseRevisionId: feature.revisionId,
		});
		expect(first.status).toBe(200);
		expect(first.body.feature.name).toBe("One");

		const stale = await call(t, t.mod, "PATCH", url, {
			name: "Two",
			baseRevisionId: feature.revisionId,
		});
		expect(stale.status).toBe(409);
		expect(stale.body.error).toBeString();
		expect(stale.body.feature).toMatchObject({
			id: feature.id,
			name: "One",
			revisionId: first.body.feature.revisionId,
		});
		expect(await revisionCount(t, feature.id)).toBe(2);

		const fresh = await call(t, t.mod, "PATCH", url, {
			name: "Two",
			baseRevisionId: first.body.feature.revisionId,
		});
		expect(fresh.status).toBe(200);
		// Without a base revision the update still goes through.
		expect((await call(t, t.mod, "PATCH", url, { name: "Three" })).status).toBe(
			200,
		);
		expect(
			(await call(t, t.mod, "PATCH", url, { baseRevisionId: 0 })).status,
		).toBe(400);
	});

	test("a deleted feature cannot be updated or deleted again", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const feature = await addPin(t, layer.id);
		const url = `/api/features/${feature.id}`;
		expect((await call(t, t.editor, "DELETE", url)).status).toBe(200);
		expect((await call(t, t.editor, "DELETE", url)).status).toBe(404);
		const patch = await call(t, t.editor, "PATCH", url, {
			name: "Zombie",
			baseRevisionId: feature.revisionId,
		});
		expect(patch.status).toBe(404);
		expect(await revisionCount(t, feature.id)).toBe(2);
	});

	test("restoring the current version adds no revision", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const feature = await addPin(t, layer.id);
		const edit = await call(
			t,
			t.editor,
			"PATCH",
			`/api/features/${feature.id}`,
			{
				name: "Edited",
			},
		);
		const restore = (revisionId: number) =>
			call(
				t,
				t.mod,
				"POST",
				`/api/features/${feature.id}/restore/${revisionId}`,
			);
		const current = await restore(edit.body.feature.revisionId);
		expect(current.status).toBe(200);
		expect(current.body.feature.name).toBe("Edited");
		expect(await revisionCount(t, feature.id)).toBe(2);

		const old = await restore(feature.revisionId);
		expect(old.status).toBe(201);
		expect(old.body.feature.name).toBe("Base");
		expect(await revisionCount(t, feature.id)).toBe(3);
	});

	test("a deleted feature is not restored into a full layer", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const many = Array.from({ length: 5000 }, (_, i) => pin(i, i));
		await call(t, t.editor, "POST", `/api/layers/${layer.id}/import`, many);
		const list = await call(t, t.editor, "GET", "/api/layers?dim=overworld");
		const victim = list.body.layers[0].features[0] as {
			id: number;
			revisionId: number;
		};
		await call(t, t.editor, "DELETE", `/api/features/${victim.id}`);
		expect((await addPin(t, layer.id)).id).toBeGreaterThan(0);

		const res = await call(
			t,
			t.mod,
			"POST",
			`/api/features/${victim.id}/restore/${victim.revisionId}`,
		);
		expect(res.status).toBe(409);
		expect(await revisionCount(t, victim.id)).toBe(2);
	});

	test("the history comes in pages, newest first", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const feature = await addPin(t, layer.id);
		for (const name of ["a", "b", "c", "d"])
			await call(t, t.editor, "PATCH", `/api/features/${feature.id}`, { name });
		const url = `/api/features/${feature.id}/history`;

		const all = await call(t, null, "GET", url);
		expect(all.body.history).toHaveLength(5);
		expect(all.body.nextBefore).toBeNull();
		const ids = all.body.history.map(
			(h: { revisionId: number }) => h.revisionId,
		);
		expect(ids).toEqual([...ids].sort((a, b) => b - a));

		const seen: number[] = [];
		let before: number | null = null;
		let pages = 0;
		do {
			const res: Awaited<ReturnType<typeof call>> = await call(
				t,
				null,
				"GET",
				`${url}?limit=2${before === null ? "" : `&before=${before}`}`,
			);
			expect(res.status).toBe(200);
			seen.push(
				...res.body.history.map((h: { revisionId: number }) => h.revisionId),
			);
			before = res.body.nextBefore;
			pages++;
		} while (before !== null);
		expect(seen).toEqual(ids);
		expect(pages).toBe(3);

		expect((await call(t, null, "GET", `${url}?limit=0`)).status).toBe(400);
		expect((await call(t, null, "GET", `${url}?limit=9999`)).status).toBe(400);
	});
});

describe("layer limits and rules", () => {
	test("replacing a layer's features by import needs its creator or a moderator", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const other = await makeUser(t.db, "other");
		const url = `/api/layers/${layer.id}/import`;
		await call(t, t.editor, "POST", url, [pin(1, 1)]);

		expect((await call(t, other, "POST", url, [pin(2, 2)])).status).toBe(201);
		const replace = `${url}?replace=1`;
		expect((await call(t, other, "POST", replace, [pin(3, 3)])).status).toBe(
			403,
		);
		const list = async () =>
			(await call(t, null, "GET", `/api/layers/${layer.id}/export`)).body;
		expect(await list()).toHaveLength(2);

		const own = await call(t, t.editor, "POST", replace, [pin(4, 4)]);
		expect(own.status).toBe(201);
		expect(own.body).toEqual({ imported: 1, replaced: 2 });
		expect((await call(t, t.mod, "POST", replace, [pin(5, 5)])).status).toBe(
			201,
		);
		expect(await list()).toHaveLength(1);
	});

	test("imported features keep their order, after the existing ones", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const url = `/api/layers/${layer.id}/import`;
		await call(t, t.editor, "POST", url, [pin(1, 0), pin(2, 0)]);
		await call(t, t.editor, "POST", url, [pin(3, 0), pin(4, 0)]);
		const xs = (
			await call(t, null, "GET", `/api/layers/${layer.id}/export`)
		).body.map((f: { geometry: number[] }) => f.geometry[0]);
		expect(xs).toEqual([1, 2, 3, 4]);
		const orders = (
			await call(t, null, "GET", "/api/layers?dim=overworld")
		).body.layers[0].features.map((f: { id: number }) => f.id);
		expect(new Set(orders).size).toBe(4);
	});

	test("everyone but moderators may create only a limited number of layers", async () => {
		const t = await bootTiles();
		const create = (user: Auth) =>
			call(t, user, "POST", "/api/layers", {
				dimension: "overworld",
				name: "L",
				color: "red",
			});
		const first = await create(t.editor);
		for (let i = 1; i < MAX_LAYERS_PER_USER; i++)
			expect((await create(t.editor)).status).toBe(201);
		const over = await create(t.editor);
		expect(over.status).toBe(409);
		expect(over.body.error).toContain(String(MAX_LAYERS_PER_USER));
		// Someone else is not affected, and moderators are exempt.
		expect((await create(await makeUser(t.db, "other"))).status).toBe(201);
		for (let i = 0; i <= MAX_LAYERS_PER_USER; i++)
			expect((await create(t.mod)).status).toBe(201);

		// A deleted layer frees a place.
		await call(t, t.editor, "DELETE", `/api/layers/${first.body.layer.id}`);
		expect((await create(t.editor)).status).toBe(201);
	});

	test("a layer's order is not changed by PATCH", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, { name: "A" });
		await makeLayer(t, t.editor, { name: "B" });
		const only = await call(t, t.editor, "PATCH", `/api/layers/${a.id}`, {
			sortOrder: 99,
		});
		expect(only.status).toBe(400);
		const both = await call(t, t.editor, "PATCH", `/api/layers/${a.id}`, {
			name: "A2",
			sortOrder: 99,
		});
		expect(both.status).toBe(200);
		expect(both.body.layer.sortOrder).toBe(0);
	});

	test("a missing layer cannot be updated", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		await call(t, t.editor, "DELETE", `/api/layers/${layer.id}`);
		expect(
			(
				await call(t, t.editor, "PATCH", `/api/layers/${layer.id}`, {
					name: "Back",
				})
			).status,
		).toBe(404);
	});

	test("`at` naming a revision that does not exist is a 404", async () => {
		const t = await bootTiles();
		for (let i = 0; i < 3; i++)
			await upload(t, await solid(T, T, RED), i * T, 0);
		await makeLayer(t);
		const at = (rev: number) =>
			call(t, null, "GET", `/api/layers?dim=overworld&at=${rev}`);
		expect((await at(1)).status).toBe(200);
		// Revision 2 was an upload that has since been deleted: there is a gap.
		await t.db.update(revisions).set({ rev: null }).where(eq(revisions.rev, 2));
		expect((await at(2)).status).toBe(404);
		expect((await at(1)).status).toBe(200);
		expect((await at(0)).status).toBe(200);
		// The head and anything newer is "now".
		expect((await at(3)).status).toBe(200);
		expect((await at(99)).status).toBe(200);
	});

	test("the creator keeps a layer a moderator made private", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const made = await call(t, t.mod, "PATCH", `/api/layers/${layer.id}`, {
			visibility: "private",
		});
		expect(made.status).toBe(200);
		await t.db.delete(layerMembers).where(eq(layerMembers.layerId, layer.id));

		const mine = await call(t, t.editor, "GET", "/api/layers?dim=overworld");
		expect(mine.body.layers).toHaveLength(1);
		expect(mine.body.layers[0]).toMatchObject({
			canEdit: true,
			canManage: true,
		});
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
		).toBe(201);
		const reorder = await call(t, t.editor, "POST", "/api/layers/reorder", {
			dimension: "overworld",
			ids: [layer.id],
		});
		expect(reorder.status).toBe(200);

		const stranger = await makeUser(t.db, "stranger");
		expect(
			(await call(t, stranger, "GET", "/api/layers?dim=overworld")).body.layers,
		).toHaveLength(0);
	});

	test("reordering renumbers when it would collide with a layer the user cannot see", async () => {
		const t = await bootTiles();
		const a = await makeLayer(t, t.editor, { name: "A" });
		const b = await makeLayer(t, t.editor, { name: "B" });
		const other = await makeUser(t.db, "other");
		const secret = await makeLayer(t, other, {
			name: "Secret",
			visibility: "private",
		});
		await t.db.update(layers).set({ sortOrder: 0 }).where(eq(layers.id, a.id));
		await t.db.update(layers).set({ sortOrder: 0 }).where(eq(layers.id, b.id));
		await t.db
			.update(layers)
			.set({ sortOrder: 1 })
			.where(eq(layers.id, secret.id));

		const res = await call(t, t.editor, "POST", "/api/layers/reorder", {
			dimension: "overworld",
			ids: [b.id, a.id],
		});
		expect(res.status).toBe(200);
		const names = async (user: Auth) =>
			(
				(await call(t, user, "GET", "/api/layers?dim=overworld")).body
					.layers as { name: string }[]
			).map((l) => l.name);
		expect(await names(t.mod)).toEqual(["B", "A", "Secret"]);
		const orders = (await t.db.select().from(layers)).map((l) => l.sortOrder);
		expect(new Set(orders).size).toBe(3);
	});

	test("a deleted feature keeps a place of its own when the others are reordered", async () => {
		const t = await bootTiles();
		const layer = await makeLayer(t);
		const add = async (x: number) =>
			(
				await call(
					t,
					t.editor,
					"POST",
					`/api/layers/${layer.id}/features`,
					pin(x),
				)
			).body.feature.id as number;
		const [a, b, c] = [await add(1), await add(2), await add(3)];
		await call(t, t.editor, "DELETE", `/api/features/${b}`);
		await t.db.update(features).set({ sortOrder: 0 }).where(eq(features.id, a));
		await t.db.update(features).set({ sortOrder: 0 }).where(eq(features.id, c));
		await t.db.update(features).set({ sortOrder: 1 }).where(eq(features.id, b));
		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/features/reorder`,
			{ ids: [c, a] },
		);
		expect(res.status).toBe(200);
		const rows = await t.db.select().from(features);
		expect(new Set(rows.map((f) => f.sortOrder)).size).toBe(3);
		const list = await call(t, null, "GET", "/api/layers?dim=overworld");
		expect(
			list.body.layers[0].features.map((f: { id: number }) => f.id),
		).toEqual([c, a]);
	});
});

describe("feature geometry", () => {
	const parse = (geometry: unknown, type: string) =>
		featureInputSchema.safeParse({ type, name: "x", geometry }).success;

	test("lines need two different points and areas three that enclose something", () => {
		expect(
			parse(
				[
					[1, 1],
					[1, 1],
				],
				"line",
			),
		).toBe(false);
		expect(
			parse(
				[
					[1, 1],
					[2, 1],
				],
				"line",
			),
		).toBe(true);
		expect(
			parse(
				[
					[0, 0],
					[5, 0],
					[5, 0],
				],
				"polygon",
			),
		).toBe(false);
		expect(
			parse(
				[
					[0, 0],
					[0, 0],
					[0, 0],
				],
				"polygon",
			),
		).toBe(false);
		expect(
			parse(
				[
					[0, 0],
					[5, 5],
					[10, 10],
				],
				"polygon",
			),
		).toBe(false);
		expect(
			parse(
				[
					[0, 0],
					[5, 0],
					[5, 5],
				],
				"polygon",
			),
		).toBe(true);
		expect(
			parse(
				[
					[-30_000_000, -30_000_000],
					[30_000_000, -30_000_000],
					[30_000_000, 30_000_000],
				],
				"polygon",
			),
		).toBe(true);
	});
});

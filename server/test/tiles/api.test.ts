import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mapMembers } from "../../src/db/schema";
import {
	BLUE,
	bootTiles,
	makeUser,
	png,
	postUpload,
	RED,
	readTile,
	revisionOf,
	solid,
	T,
	upload,
} from "../helpers";

describe("upload validation", () => {
	test("requires login and the editor role", async () => {
		const t = await bootTiles();
		const data = await solid(T, T, RED);
		expect(
			(await postUpload(t, null, [{ name: "a_x0_z0.png", data }])).status,
		).toBe(401);

		const viewer = await makeUser(t.db, "viewer");
		await t.db
			.insert(mapMembers)
			.values({ mapId: t.mapId, userId: "viewer", role: "viewer" });
		expect(
			(await postUpload(t, viewer, [{ name: "a_x0_z0.png", data }])).status,
		).toBe(403);
	});

	test("coordinates come from the file name, negative values included", async () => {
		const t = await bootTiles();
		const res = await postUpload(t, t.editor, [
			{ name: "Overworld_x-16_z-32.png", data: await solid(T, T, RED) },
		]);
		expect(res.status).toBe(202);
		await t.services.worker.run();
		expect(await readTile(t, 0, -1, -2)).not.toBeNull();
	});

	test("explicit coords override file names; accepts the plain `files` field", async () => {
		const t = await bootTiles();
		const res = await postUpload(
			t,
			t.editor,
			[{ name: "whatever_x999_z999.png", data: await solid(T, T, RED) }],
			{ coords: [{ x: 16, z: 0 }], field: "files" },
		);
		expect(res.status).toBe(202);
		await t.services.worker.run();
		expect(await readTile(t, 0, 1, 0)).not.toBeNull();
		expect(await readTile(t, 0, 62, 62)).toBeNull();
	});

	test("rejects the whole request with per-file errors", async () => {
		const t = await bootTiles();
		const good = await solid(T, T, RED);
		const res = await postUpload(t, t.editor, [
			{ name: "ok_x0_z0.png", data: good },
			{ name: "nocoords.png", data: good },
			{ name: "fake_x0_z0.png", data: Buffer.from("not an image") },
			{ name: "notes.txt", data: Buffer.from("hi") },
		]);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { errors: { file: string }[] };
		expect(body.errors.map((e) => e.file).sort()).toEqual([
			"fake_x0_z0.png",
			"nocoords.png",
			"notes.txt",
		]);
		expect(await readTile(t, 0, 0, 0)).toBeNull();
		expect(
			(await (await t.app.request("/api/maps/aomc/revisions")).json())
				.revisions,
		).toHaveLength(0);
	});

	test("rejects oversized images, bad coords arrays, too many files, empty requests", async () => {
		const t = await bootTiles({
			MAX_IMAGE_DIM: "32",
			MAX_FILES_PER_UPLOAD: "2",
		});
		const small = await solid(T, T, RED);
		const big = await solid(33, 4, RED);
		expect(
			(await postUpload(t, t.editor, [{ name: "b_x0_z0.png", data: big }]))
				.status,
		).toBe(400);
		expect(
			(
				await postUpload(t, t.editor, [{ name: "a_x0_z0.png", data: small }], {
					coords: [],
				})
			).status,
		).toBe(400);
		const three = [0, 1, 2].map((i) => ({
			name: `a_x${i}_z0.png`,
			data: small,
		}));
		expect((await postUpload(t, t.editor, three)).status).toBe(400);
		expect((await postUpload(t, t.editor, [])).status).toBe(400);
	});

	test("enforces the byte limit", async () => {
		const t = await bootTiles({ MAX_UPLOAD_BYTES: "100" });
		const res = await postUpload(t, t.editor, [
			{ name: "a_x0_z0.png", data: await solid(T, T, RED) },
		]);
		expect(res.status).toBe(413);
	});

	test("unknown or archived dimensions are rejected", async () => {
		const t = await bootTiles();
		const data = await solid(T, T, RED);
		expect(
			(
				await postUpload(t, t.editor, [{ name: "a_x0_z0.png", data }], {
					dim: "nope",
				})
			).status,
		).toBe(404);
		await t.app.request("/api/maps/aomc/dimensions/nether", {
			method: "PATCH",
			body: JSON.stringify({ archived: true }),
			headers: { ...t.mod.auth, "Content-Type": "application/json" },
		});
		expect(
			(
				await postUpload(t, t.editor, [{ name: "a_x0_z0.png", data }], {
					dim: "nether",
				})
			).status,
		).toBe(400);
	});

	test("is rate limited per user", async () => {
		const t = await bootTiles({ UPLOAD_RATE_LIMIT: "1" });
		const data = await solid(T, T, RED);
		expect(
			(await postUpload(t, t.editor, [{ name: "a_x0_z0.png", data }])).status,
		).toBe(202);
		expect(
			(await postUpload(t, t.editor, [{ name: "a_x0_z0.png", data }])).status,
		).toBe(429);
		expect(
			(await postUpload(t, t.mod, [{ name: "a_x0_z0.png", data }])).status,
		).toBe(202);
		await t.services.worker.run();
	});
});

describe("zip uploads", () => {
	test("expands PNGs, ignoring directories, junk and non-PNG entries", async () => {
		const t = await bootTiles();
		const zip = zipSync({
			"export/Overworld_x0_z0.png": new Uint8Array(await solid(T, T, RED)),
			"Overworld_x16_z0.png": new Uint8Array(await solid(T, T, BLUE)),
			"__MACOSX/._Overworld_x0_z0.png": new Uint8Array([1, 2, 3]),
			"readme.txt": new Uint8Array([104, 105]),
		});
		const res = await postUpload(t, t.editor, [
			{ name: "export.zip", data: zip },
		]);
		expect(res.status).toBe(202);
		const { revisionId } = (await res.json()) as { revisionId: number };
		await t.services.worker.run();
		const rev = await revisionOf(t, revisionId);
		expect(rev).toMatchObject({ status: "done", fileCount: 2 });
		expect(await readTile(t, 0, 0, 0)).not.toBeNull();
		expect(await readTile(t, 0, 1, 0)).not.toBeNull();
	});

	test("zip entries without coordinates are reported", async () => {
		const t = await bootTiles();
		const zip = zipSync({ "a.png": new Uint8Array(await solid(T, T, RED)) });
		const res = await postUpload(t, t.editor, [{ name: "x.zip", data: zip }]);
		expect(res.status).toBe(400);
	});

	test("a corrupt zip is a clean 400", async () => {
		const t = await bootTiles();
		const res = await postUpload(t, t.editor, [
			{ name: "x.zip", data: Buffer.from("PK nonsense") },
		]);
		expect(res.status).toBe(400);
	});
});

describe("progress and revisions API", () => {
	test("SSE stream reports a finished revision and closes", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const res = await t.app.request(`/api/revisions/${id}/events`);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("event: done");
		expect(text).toContain('"rev":1');
	});

	test("SSE stream delivers live events for a queued job", async () => {
		const t = await bootTiles();
		const res = await postUpload(t, t.editor, [
			{ name: "a_x0_z0.png", data: await solid(T, T, RED) },
		]);
		const { revisionId } = (await res.json()) as { revisionId: number };
		const events = await t.app.request(`/api/revisions/${revisionId}/events`);
		const text = await events.text();
		expect(text).toContain("event: done");
	});

	test("polling endpoint and list include author, bbox and status", async () => {
		const t = await bootTiles();
		const id = await upload(t, await solid(T, T, RED), 32, 48);
		const rev = await revisionOf(t, id);
		expect(rev).toMatchObject({
			kind: "upload",
			status: "done",
			authorName: "editor",
			fileCount: 1,
			bbox: { minX: 32, minZ: 48, maxX: 47, maxZ: 63 },
		});
		const list = await (await t.app.request("/api/maps/aomc/revisions")).json();
		expect(list.revisions.map((r: { id: number }) => r.id)).toEqual([id]);
		expect((await t.app.request("/api/revisions/9999")).status).toBe(404);
		expect((await t.app.request("/api/revisions/abc")).status).toBe(404);
	});
});

describe("private maps", () => {
	async function privateMap() {
		const t = await bootTiles();
		const owner = await makeUser(t.db, "owner");
		const outsider = await makeUser(t.db, "outsider");
		const created = await t.app.request("/api/maps", {
			method: "POST",
			body: JSON.stringify({ slug: "priv", name: "Priv", tileSize: T }),
			headers: { ...owner.auth, "Content-Type": "application/json" },
		});
		expect(created.status).toBe(201);
		return { t, owner, outsider };
	}

	test("tiles, uploads and revisions of a private map are invisible to outsiders", async () => {
		const { t, owner, outsider } = await privateMap();
		const form = new FormData();
		form.append(
			"files[]",
			new File([(await solid(T, T, RED)) as BlobPart], "a.png"),
		);
		form.append("coords", JSON.stringify([{ x: 0, z: 0 }]));
		const base = "/api/maps/priv/dimensions";
		await t.app.request("/api/maps/priv/dimensions", {
			method: "POST",
			body: JSON.stringify({ slug: "overworld", name: "Overworld" }),
			headers: { ...owner.auth, "Content-Type": "application/json" },
		});

		const asOutsider = await t.app.request(`${base}/overworld/uploads`, {
			method: "POST",
			body: form,
			headers: outsider.auth,
		});
		expect(asOutsider.status).toBe(404);

		const ok = await t.app.request(`${base}/overworld/uploads`, {
			method: "POST",
			body: form,
			headers: owner.auth,
		});
		expect(ok.status).toBe(202);
		const { revisionId } = (await ok.json()) as { revisionId: number };
		await t.services.worker.run();

		const tilePath = `${base}/overworld/tiles/0/0/0`;
		expect((await t.app.request(tilePath)).status).toBe(404);
		expect(
			(await t.app.request(tilePath, { headers: outsider.auth })).status,
		).toBe(404);
		const mine = await t.app.request(tilePath, { headers: owner.auth });
		expect(mine.status).toBe(302);
		expect(mine.headers.get("cache-control")).toStartWith("private");

		expect(
			(
				await t.app.request(`/api/revisions/${revisionId}`, {
					headers: outsider.auth,
				})
			).status,
		).toBe(404);
		expect(
			(await t.app.request(`/api/revisions/${revisionId}/events`)).status,
		).toBe(404);
		expect(
			(
				await t.app.request(`/api/revisions/${revisionId}/revert`, {
					method: "POST",
					headers: outsider.auth,
				})
			).status,
		).toBe(404);
		expect(
			(
				await t.app.request("/api/maps/priv/revisions", {
					headers: outsider.auth,
				})
			).status,
		).toBe(404);
	});
});

describe("tile and blob routes", () => {
	test("validates zoom and coordinates, 204s for empty tiles", async () => {
		const t = await bootTiles();
		const base = "/api/maps/aomc/dimensions/overworld/tiles";
		expect((await t.app.request(`${base}/0/5/5`)).status).toBe(204);
		expect((await t.app.request(`${base}/4/0/0`)).status).toBe(400);
		expect((await t.app.request(`${base}/-1/0/0`)).status).toBe(400);
		expect((await t.app.request(`${base}/0/x/0`)).status).toBe(400);
		expect(
			(await t.app.request("/api/maps/aomc/dimensions/nope/tiles/0/0/0"))
				.status,
		).toBe(404);
		expect(
			(await t.app.request("/api/maps/nope/dimensions/overworld/tiles/0/0/0"))
				.status,
		).toBe(404);
	});

	test("blobs are immutable WebP, and malformed names never touch the disk", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		const res = await t.app.request(
			"/api/maps/aomc/dimensions/overworld/tiles/0/0/0",
		);
		const location = res.headers.get("location") as string;
		expect(location).toMatch(/^\/blobs\/[0-9a-f]{64}\.webp$/);

		const blob = await t.app.request(location);
		expect(blob.status).toBe(200);
		expect(blob.headers.get("content-type")).toBe("image/webp");
		expect(blob.headers.get("cache-control")).toContain("immutable");

		for (const bad of [
			"/blobs/..%2f..%2fdb.sqlite",
			"/blobs/abc.webp",
			`/blobs/${"0".repeat(64)}.webp`,
			`/blobs/${"a".repeat(64)}`,
		]) {
			expect((await t.app.request(bad)).status).toBe(404);
		}
	});

	test("equal tiles share one blob (content addressing)", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0);
		await upload(t, await solid(T, T, RED), 16, 0);
		const loc = async (x: number) =>
			(
				await t.app.request(
					`/api/maps/aomc/dimensions/overworld/tiles/0/${x}/0`,
				)
			).headers.get("location");
		expect(await loc(0)).toBe(await loc(1));
	});

	test("a mixed-content png round-trips pixel exactly through WebP", async () => {
		const t = await bootTiles();
		await upload(
			t,
			await png(T, T, (x, y) => [x * 15, y * 15, (x + y) * 7 + 1]),
			0,
			0,
		);
		const tile = (await readTile(t, 0, 0, 0)) as Buffer;
		const o = (5 * T + 9) * 4;
		expect([...tile.subarray(o, o + 4)]).toEqual([
			9 * 15,
			5 * 15,
			14 * 7 + 1,
			255,
		]);
	});
});

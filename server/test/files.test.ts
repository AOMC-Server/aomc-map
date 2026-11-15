import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApiToken } from "../src/auth/tokens";
import { filesDir } from "../src/paths";
import { contentDisposition, parseRange } from "../src/routes/fileDownloads";
import {
	type Auth,
	addMember,
	call,
	cleanupTempDirs,
	makeTempDir,
	makeTestApp,
	makeUser,
} from "./helpers";

afterAll(cleanupTempDirs);

type App = ReturnType<typeof makeTestApp>;

async function boot(env: Record<string, string> = {}) {
	const t = makeTestApp(env);
	const mod = await makeUser(t.db, "mod");
	await addMember(t, "mod", "moderator");
	const alice = await makeUser(t.db, "alice");
	const bob = await makeUser(t.db, "bob");
	return { ...t, mod, alice, bob };
}

async function put(
	t: App,
	user: Auth,
	path: string,
	name: string,
	data: string | Uint8Array,
	onConflict?: string,
) {
	const q = new URLSearchParams({ path, name });
	if (onConflict) q.set("onConflict", onConflict);
	const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const res = await t.app.request(`/api/files/upload?${q}`, {
		method: "PUT",
		body: body as BlobPart,
		headers: {
			...(user?.auth ?? {}),
			"Content-Length": String(body.byteLength),
		},
	});
	const text = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
	return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

async function folder(
	t: App,
	user: Auth,
	name: string,
	parentId: number | null = null,
) {
	const res = await call(t, user, "POST", "/api/files/folders", {
		parentId,
		name,
	});
	if (res.status !== 201)
		throw new Error(`folder: ${res.status} ${JSON.stringify(res.body)}`);
	return res.body.folder.id as number;
}

const stored = (t: App) =>
	existsSync(filesDir(t.env.DATA_DIR))
		? readdirSync(filesDir(t.env.DATA_DIR)).filter((n) =>
				/^[0-9a-f]{64}$/.test(n),
			)
		: [];

const grant = (t: App & { mod: Auth }, folderId: number, userId: string) =>
	call(t, t.mod, "POST", `/api/files/folders/${folderId}/grants`, { userId });

describe("file library", () => {
	test("is for logged-in users only", async () => {
		const t = await boot();
		expect((await call(t, null, "GET", "/api/files/tree")).status).toBe(401);
		const res = await call(t, t.alice, "GET", "/api/files/tree");
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			folder: null,
			path: "/",
			folders: [],
			files: [],
			canWrite: false,
			canManage: false,
		});
		expect(res.body.limits.maxFileBytes).toBeGreaterThan(0);
	});

	test("moderators write anywhere; others only where they were given access", async () => {
		const t = await boot();
		expect(
			(
				await call(t, t.alice, "POST", "/api/files/folders", {
					parentId: null,
					name: "voxy",
				})
			).status,
		).toBe(403);
		const voxy = await folder(t, t.mod, "voxy");
		await folder(t, t.mod, "xaero");
		expect((await put(t, t.alice, "/voxy", "a.zip", "hello")).status).toBe(403);

		expect((await grant(t, voxy, "alice")).status).toBe(201);
		const sub = await folder(t, t.alice, "worlds", voxy);
		expect((await put(t, t.alice, "/voxy", "a.zip", "hello")).status).toBe(201);
		expect((await put(t, t.alice, "/voxy/worlds", "b.zip", "hi")).status).toBe(
			201,
		);
		expect((await put(t, t.alice, "/xaero", "c.zip", "x")).status).toBe(403);
		expect((await put(t, t.alice, "/", "d.zip", "x")).status).toBe(403);
		expect((await put(t, t.bob, "/voxy", "e.zip", "x")).status).toBe(403);

		const top = await call(t, t.alice, "GET", "/api/files/tree");
		expect(
			top.body.folders.map((f: { name: string; canWrite: boolean }) => [
				f.name,
				f.canWrite,
			]),
		).toEqual([
			["voxy", true],
			["xaero", false],
		]);
		const inside = await call(t, t.alice, "GET", "/api/files/tree?path=/VOXY");
		expect(inside.body.canWrite).toBe(true);
		expect(inside.body.folders[0]).toMatchObject({
			id: sub,
			name: "worlds",
			items: 1,
		});
		expect(inside.body.files[0]).toMatchObject({
			name: "a.zip",
			bytes: 5,
			url: "/files/voxy/a.zip",
			uploadedBy: { id: "alice" },
		});
		expect(inside.body.breadcrumbs).toEqual([
			{ id: voxy, name: "voxy", url: "/files/voxy/" },
		]);

		// Taking the access away stops further changes.
		expect(
			(
				await call(
					t,
					t.mod,
					"DELETE",
					`/api/files/folders/${voxy}/grants/alice`,
				)
			).status,
		).toBe(200);
		expect((await put(t, t.alice, "/voxy", "f.zip", "x")).status).toBe(403);
	});

	test("downloads need a login and support ranges and revalidation", async () => {
		const t = await boot();
		await folder(t, t.mod, "presets");
		const up = await put(
			t,
			t.mod,
			"/presets",
			"Mon preset é.txt",
			"0123456789",
		);
		expect(up.status).toBe(201);
		const url = up.body.file.url as string;
		expect(url).toBe("/files/presets/Mon%20preset%20%C3%A9.txt");

		const anon = await t.app.request(url);
		expect(anon.status).toBe(302);
		expect(anon.headers.get("location")).toBe(
			`/auth/discord?returnTo=${encodeURIComponent(url)}`,
		);

		const res = await t.app.request(url, { headers: t.alice.auth });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("0123456789");
		expect(res.headers.get("content-disposition")).toContain(
			"filename*=UTF-8''Mon%20preset%20%C3%A9.txt",
		);
		const etag = res.headers.get("etag") as string;

		const part = await t.app.request(url, {
			headers: { ...t.alice.auth, Range: "bytes=2-4" },
		});
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
		expect(await part.text()).toBe("234");

		const again = await t.app.request(url, {
			headers: { ...t.alice.auth, "If-None-Match": etag },
		});
		expect(again.status).toBe(304);

		const tree = await call(t, t.alice, "GET", "/api/files/tree?path=/presets");
		expect(tree.body.files[0].downloads).toBe(1);

		// A token without `read` is anonymous for reads.
		const { token } = await createApiToken(t.db, "alice", "up", null, [
			"upload",
		]);
		const noRead = await t.app.request(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(noRead.status).toBe(403);
	});

	test("folders and unknown paths are left to the web app", async () => {
		const dist = makeTempDir("aomc-dist-");
		mkdirSync(join(dist, "assets"));
		writeFileSync(join(dist, "index.html"), "<title>app</title>");
		const t = await boot({ WEB_DIST: dist });
		await folder(t, t.mod, "voxy");
		for (const path of ["/files", "/files/", "/files/voxy/", "/files/nope"]) {
			const res = await t.app.request(path);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain("<title>app</title>");
		}
	});

	test("a name that is taken: fail, replace or keep both", async () => {
		const t = await boot();
		const first = await put(t, t.mod, "/", "world.zip", "one");
		expect(first.status).toBe(201);
		const clash = await put(t, t.mod, "/", "WORLD.zip", "two");
		expect(clash.status).toBe(409);
		expect(clash.body.conflict).toBe("file");

		const replaced = await put(t, t.mod, "/", "world.zip", "two", "replace");
		expect(replaced.status).toBe(201);
		expect(replaced.body.replaced).toBe(true);
		expect(replaced.body.file.id).toBe(first.body.file.id);
		expect(stored(t)).toEqual([replaced.body.file.sha256]);

		const kept = await put(t, t.mod, "/", "world.zip", "three", "rename");
		expect(kept.body.file.name).toBe("world (2).zip");
		const kept2 = await put(t, t.mod, "/", "world.zip", "four", "rename");
		expect(kept2.body.file.name).toBe("world (3).zip");

		await folder(t, t.mod, "maps");
		const onFolder = await put(t, t.mod, "/", "Maps", "x", "replace");
		expect(onFolder.status).toBe(409);
		expect(onFolder.body.conflict).toBe("folder");
	});

	test("identical content is stored once and removed with its last file", async () => {
		const t = await boot();
		const a = await put(t, t.mod, "/", "a.bin", "same");
		const b = await put(t, t.mod, "/", "b.bin", "same");
		expect(stored(t)).toHaveLength(1);
		await call(t, t.mod, "DELETE", `/api/files/entries/${a.body.file.id}`);
		expect(stored(t)).toHaveLength(1);
		await call(t, t.mod, "DELETE", `/api/files/entries/${b.body.file.id}`);
		expect(stored(t)).toHaveLength(0);
	});

	test("limits: file size, quota, and a body that does not match its length", async () => {
		const t = await boot({ MAX_FILE_BYTES: "10", FILES_QUOTA_BYTES: "15" });
		expect((await put(t, t.mod, "/", "big", "x".repeat(11))).status).toBe(413);
		const res = await t.app.request("/api/files/upload?path=/&name=d", {
			method: "PUT",
			body: "12345",
			headers: { ...t.mod.auth, "Content-Length": "3" },
		});
		expect(res.status).toBe(400);
		expect(readdirSync(join(filesDir(t.env.DATA_DIR), "tmp"))).toEqual([]);
		expect((await put(t, t.mod, "/", "a", "x".repeat(10))).status).toBe(201);
		expect((await put(t, t.mod, "/", "b", "y".repeat(10))).status).toBe(507);
		expect((await put(t, t.mod, "/", "c", "y".repeat(5))).status).toBe(201);
	});

	test("bad names are refused", async () => {
		const t = await boot();
		for (const name of ["..", "a/b", "a\\b", " pad", ""]) {
			expect((await put(t, t.mod, "/", name, "x")).status).toBe(400);
		}
	});

	test("deleting a folder that holds things takes recursive=1", async () => {
		const t = await boot();
		const top = await folder(t, t.mod, "top");
		await folder(t, t.mod, "inner", top);
		await put(t, t.mod, "/top/inner", "f.bin", "data");
		expect(
			(await call(t, t.mod, "DELETE", `/api/files/folders/${top}`)).status,
		).toBe(409);
		expect(
			(await call(t, t.mod, "DELETE", `/api/files/folders/${top}?recursive=1`))
				.status,
		).toBe(200);
		expect(stored(t)).toHaveLength(0);
		expect(
			(await call(t, t.mod, "GET", "/api/files/tree?path=/top")).status,
		).toBe(404);
	});

	test("moving and renaming", async () => {
		const t = await boot();
		const a = await folder(t, t.mod, "a");
		const b = await folder(t, t.mod, "b", a);
		expect(
			(
				await call(t, t.mod, "PATCH", `/api/files/folders/${a}`, {
					parentId: b,
				})
			).status,
		).toBe(409);
		const file = await put(t, t.mod, "/a", "x.txt", "x");
		const moved = await call(
			t,
			t.mod,
			"PATCH",
			`/api/files/entries/${file.body.file.id}`,
			{ folderId: b, name: "y.txt" },
		);
		expect(moved.status).toBe(200);
		expect(moved.body.file.url).toBe("/files/a/b/y.txt");
		const renamed = await call(t, t.mod, "PATCH", `/api/files/folders/${b}`, {
			name: "c",
			parentId: null,
		});
		expect(renamed.body.folder.path).toBe("/c");
		const res = await t.app.request("/files/c/y.txt", { headers: t.mod.auth });
		expect(await res.text()).toBe("x");
	});

	test("access is listed for moderators, with what comes from above", async () => {
		const t = await boot();
		const a = await folder(t, t.mod, "a");
		const b = await folder(t, t.mod, "b", a);
		await grant(t, a, "alice");
		await grant(t, b, "bob");
		expect(
			(await call(t, t.alice, "GET", `/api/files/folders/${b}/grants`)).status,
		).toBe(403);
		const res = await call(t, t.mod, "GET", `/api/files/folders/${b}/grants`);
		expect(res.body.grants.map((g: { userId: string }) => g.userId)).toEqual([
			"bob",
		]);
		expect(res.body.inherited).toMatchObject([{ userId: "alice", path: "/a" }]);
		expect((await grant(t, a, "nobody")).status).toBe(404);
	});

	test("tokens need the upload scope to write", async () => {
		const t = await boot();
		const { token } = await createApiToken(t.db, "mod", "r", null, ["read"]);
		const res = await put(
			t,
			{ auth: { Authorization: `Bearer ${token}` } },
			"/",
			"a",
			"x",
		);
		expect(res.status).toBe(403);
	});
});

describe("download helpers", () => {
	test("parseRange", () => {
		expect(parseRange(undefined, 10)).toBeNull();
		expect(parseRange("bytes=0-", 10)).toEqual([0, 9]);
		expect(parseRange("bytes=-3", 10)).toEqual([7, 9]);
		expect(parseRange("bytes=5-100", 10)).toEqual([5, 9]);
		expect(parseRange("bytes=10-", 10)).toBe("invalid");
		expect(parseRange("bytes=0-1,3-4", 10)).toBeNull();
	});

	test("contentDisposition keeps the name and a plain fallback", () => {
		expect(contentDisposition('a "b" é.zip')).toBe(
			"attachment; filename=\"a _b_ _.zip\"; filename*=UTF-8''a%20%22b%22%20%C3%A9.zip",
		);
	});
});

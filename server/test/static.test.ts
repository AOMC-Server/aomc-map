import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir, makeTestApp } from "./helpers";

afterAll(cleanupTempDirs);

function makeDist() {
	const dir = makeTempDir("aomc-dist-");
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
	writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
	writeFileSync(join(dir, "favicon.txt"), "icon");
	return dir;
}

describe("static web app", () => {
	test("serves index.html at / and for client-side routes", async () => {
		const { app } = makeTestApp({ WEB_DIST: makeDist() });
		for (const path of ["/invite/abc", "/some/deep/link"]) {
			const res = await app.request(path);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain("<title>app</title>");
		}
		// The root page also gets share tags (see html.test.ts), so only its shell is checked.
		const root = await app.request("/");
		expect(root.status).toBe(200);
		expect(await root.text()).toStartWith("<!doctype html>");
	});

	test("serves files, with immutable caching for hashed assets", async () => {
		const { app } = makeTestApp({ WEB_DIST: makeDist() });
		const asset = await app.request("/assets/app-abc123.js");
		expect(asset.status).toBe(200);
		expect(asset.headers.get("cache-control")).toContain("immutable");
		expect(await (await app.request("/favicon.txt")).text()).toBe("icon");
	});

	test("unknown API, auth and blob paths are JSON 404s, not the SPA", async () => {
		const { app } = makeTestApp({ WEB_DIST: makeDist() });
		for (const path of ["/api/nope", "/auth/nope", "/blobs/"]) {
			const res = await app.request(path);
			expect(res.status).toBe(404);
			expect(res.headers.get("content-type")).toContain("application/json");
		}
	});

	test("the app shell is never cached, so a new build is picked up", async () => {
		const { app } = makeTestApp({ WEB_DIST: makeDist() });
		for (const path of ["/", "/invite/abc", "/some/deep/link"]) {
			const res = await app.request(path);
			expect(res.headers.get("cache-control")).toBe("no-cache");
		}
	});

	test("unknown API, auth and blob paths are 404s for every method", async () => {
		const { app } = makeTestApp({ WEB_DIST: makeDist() });
		for (const method of ["POST", "PUT", "DELETE"]) {
			for (const path of ["/api/nope", "/auth/nope", "/blobs/nope"]) {
				const res = await app.request(path, { method });
				expect(res.status).toBe(404);
				expect(res.headers.get("content-type")).toContain("application/json");
			}
		}
	});

	test("without a build the API still works and / is a 404", async () => {
		const { app } = makeTestApp({
			WEB_DIST: join(tmpdir(), "aomc-no-such-dist"),
		});
		expect((await app.request("/")).status).toBe(404);
		expect((await app.request("/api/me")).status).toBe(200);
	});
});

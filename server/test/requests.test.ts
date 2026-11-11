import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { MAX_JSON_BYTES } from "@aomc/shared";
import { createRateLimiter } from "../src/ratelimit";
import { bootTiles, call, cleanupTempDirs, json, postUpload } from "./helpers";

afterAll(cleanupTempDirs);

describe("request errors", () => {
	test("a request that fails validation gets a short JSON error that does not echo it", async () => {
		const t = await bootTiles();
		const res = await call(t, t.editor, "POST", "/api/layers", {
			dimension: "overworld",
			name: "",
			secret: "do-not-echo",
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("invalid request");
		expect(res.body).not.toHaveProperty("data");
		expect(res.body.issues).toEqual([
			{ path: ["name"], message: expect.any(String) },
		]);
		expect(JSON.stringify(res.body)).not.toContain("do-not-echo");

		const query = await call(t, null, "GET", "/api/stats?range=1y");
		expect(query.status).toBe(400);
		expect(query.body.error).toBe("invalid request");
		expect(query.body.issues[0].path).toEqual(["range"]);
	});

	test("every route that validates its input answers in the same format", async () => {
		const t = await bootTiles({}, { owner: true });
		const layer = (
			await call(t, t.editor, "POST", "/api/layers", {
				dimension: "overworld",
				name: "mine",
			})
		).body.layer;
		const bad = [
			["POST", `/api/layers/${layer.id}/invites`, { maxUses: 0 }],
			["POST", "/api/invites", { maxUses: 0 }],
			["POST", `/api/layers/${layer.id}/members`, { role: "x" }],
			["PATCH", `/api/layers/${layer.id}/members/someone`, { role: "x" }],
			["POST", "/api/members", { role: "x" }],
			["PATCH", "/api/members/someone", { role: "x" }],
		] as const;
		for (const [method, path, body] of bad) {
			const res = await call(t, t.owner, method, path, body);
			expect(res.status, `${method} ${path}`).toBe(400);
			expect(res.body.error).toBe("invalid request");
			expect(res.body.issues.length).toBeGreaterThan(0);
		}
	});

	test("malformed JSON is a 400 in the API's format", async () => {
		const t = await bootTiles();
		const res = await t.app.request("/api/layers", {
			method: "POST",
			headers: { ...t.editor.auth, "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(((await res.json()) as { error: string }).error).toBeString();
	});

	test("a server error is a generic JSON 500", async () => {
		const t = await bootTiles();
		const log = spyOn(console, "error").mockImplementation(() => {});
		t.services.preview.get = async () => {
			throw new Error("secret detail");
		};
		const res = await t.app.request("/api/preview.png?x=0&z=0");
		log.mockRestore();
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "internal server error" });
	});
});

describe("body size", () => {
	test("a JSON body over the limit is refused before it is read", async () => {
		const t = await bootTiles();
		const huge = JSON.stringify([
			{ type: "pin", name: "x".repeat(MAX_JSON_BYTES), geometry: [0, 0] },
		]);
		const res = await t.app.request("/api/layers/1/import", {
			method: "POST",
			headers: { ...t.editor.auth, "Content-Type": "application/json" },
			body: huge,
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "request body too large" });
	});

	test("a body without a declared length is limited too", async () => {
		const t = await bootTiles();
		const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
		const body = new ReadableStream({
			start(controller) {
				for (let i = 0; i < 20; i++) controller.enqueue(chunk);
				controller.close();
			},
		});
		const res = await t.app.request("/api/layers", {
			method: "POST",
			headers: { ...t.editor.auth, "Content-Type": "application/json" },
			body,
			// @ts-expect-error Bun needs this for streamed request bodies
			duplex: "half",
		});
		expect(res.status).toBe(413);
	});

	test("uploads keep their own, larger limit", async () => {
		const t = await bootTiles();
		const big = new Uint8Array(MAX_JSON_BYTES + 1024);
		const res = await postUpload(t, t.editor, [
			{ name: "Overworld_x0_z0.png", data: big },
		]);
		expect(res.status).not.toBe(413);
	});
});

describe("write rate limit", () => {
	test("layer and feature writes are limited per user, reads are not", async () => {
		const t = await bootTiles();
		t.services.writeLimiter = createRateLimiter(3);
		const create = (user = t.editor) =>
			call(t, user, "POST", "/api/layers", {
				dimension: "overworld",
				name: "L",
				color: "red",
			});
		const layer = (await create()).body.layer as { id: number };
		const rename = (name: string) =>
			call(t, t.editor, "PATCH", `/api/layers/${layer.id}`, { name });
		expect((await rename("a")).status).toBe(200);
		expect((await rename("b")).status).toBe(200);
		const limited = await rename("c");
		expect(limited.status).toBe(429);
		expect(limited.body.error).toBeString();

		const feature = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/features`,
			{ type: "pin", name: "x", geometry: [0, 0] },
		);
		expect(feature.status).toBe(429);
		expect((await call(t, t.editor, "GET", "/api/layers")).status).toBe(200);
		// Someone else has their own allowance.
		expect((await create(t.mod)).status).toBe(201);
	});

	test("an anonymous write is still a 401, not a 429", async () => {
		const t = await bootTiles();
		t.services.writeLimiter = createRateLimiter(0);
		const res = await t.app.request("/api/layers", {
			method: "POST",
			...json({ dimension: "overworld", name: "L" }),
		});
		expect(res.status).toBe(401);
	});
});

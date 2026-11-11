import { afterAll, describe, expect, test } from "bun:test";
import { createApiToken } from "../src/auth/tokens";
import { SHORT_LINK_RATE_LIMIT } from "../src/ratelimit";
import { viewQuery } from "../src/routes/links";
import { call, cleanupTempDirs, makeTestApp, makeUser } from "./helpers";

afterAll(cleanupTempDirs);

const view = { dim: "overworld", x: 120, z: -40, zoom: 1.5 };

describe("short links", () => {
	test("anyone can make one; it redirects to the view", async () => {
		const t = makeTestApp();
		const res = await call(t, null, "POST", "/api/links", {
			...view,
			rev: 3,
			layers: [5, 2, 5],
		});
		expect(res.status).toBe(201);
		expect(res.body.url).toBe(`http://localhost:3000/s/${res.body.code}`);
		expect(res.body.code).toMatch(/^[0-9A-Za-z]{7}$/);

		const open = await t.app.request(`/s/${res.body.code}`);
		expect(open.status).toBe(302);
		expect(open.headers.get("Location")).toBe(
			"/?dim=overworld&x=120&z=-40&zoom=1.5&rev=3&layers=2%2C5",
		);
	});

	test("the same view gets the same link, however its layers are listed", async () => {
		const t = makeTestApp();
		const user = await makeUser(t.db, "1");
		const a = await call(t, null, "POST", "/api/links", {
			...view,
			layers: [3, 1],
		});
		const b = await call(t, user, "POST", "/api/links", {
			...view,
			layers: [1, 3, 3],
		});
		expect(b.status).toBe(200);
		expect(b.body.code).toBe(a.body.code);

		// No layers listed (their defaults) and no layers shown are different views.
		const none = await call(t, null, "POST", "/api/links", {
			...view,
			layers: [],
		});
		const defaults = await call(t, null, "POST", "/api/links", view);
		expect(
			new Set([a.body.code, none.body.code, defaults.body.code]).size,
		).toBe(3);
		const open = await t.app.request(`/s/${none.body.code}`);
		expect(open.headers.get("Location")).toEndWith("&layers=");
	});

	test("views are validated", async () => {
		const t = makeTestApp();
		for (const bad of [
			{ ...view, dim: "nowhere" },
			{ ...view, x: 1.5 },
			{ ...view, zoom: -100 },
			{ ...view, layers: [0] },
			{ ...view, rev: -1 },
			{ x: 0, z: 0, zoom: 0 },
		])
			expect((await call(t, null, "POST", "/api/links", bad)).status).toBe(400);
	});

	test("unknown links answer 404", async () => {
		const t = makeTestApp();
		expect((await t.app.request("/s/nope123")).status).toBe(404);
		expect((await t.app.request("/s/not-a-code!")).status).toBe(404);
	});

	test("making links is rate limited per client", async () => {
		const t = makeTestApp();
		for (let i = 0; i < SHORT_LINK_RATE_LIMIT; i++)
			expect(
				(await call(t, null, "POST", "/api/links", { ...view, x: i })).status,
			).toBe(201);
		expect(
			(await call(t, null, "POST", "/api/links", { ...view, x: -1 })).status,
		).toBe(429);
	});

	test("any token may make links", async () => {
		const t = makeTestApp();
		await makeUser(t.db, "1");
		const { token } = await createApiToken(t.db, "1", "read only", null, [
			"read",
		]);
		const res = await call(
			t,
			{ auth: { Authorization: `Bearer ${token}` } },
			"POST",
			"/api/links",
			view,
		);
		expect(res.status).toBe(201);
	});

	test("the query matches the address bar's rounding", () => {
		expect(viewQuery({ ...view, zoom: 1.23456 })).toBe(
			"dim=overworld&x=120&z=-40&zoom=1.23",
		);
	});
});

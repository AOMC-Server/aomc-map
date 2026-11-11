import { afterAll, describe, expect, test } from "bun:test";
import { MAX_TOKENS_PER_USER } from "@aomc/shared";
import { eq } from "drizzle-orm";
import { upsertUser } from "../src/auth/discord";
import { apiTokens, mapInfo, members, pendingOwners } from "../src/db/schema";
import { parseEnv } from "../src/env";
import { runSetup } from "../src/setup";

afterAll(cleanupTempDirs);

import {
	addMember,
	call,
	cleanupTempDirs,
	json,
	makeSessionCookie,
	makeTestApp,
	makeUser,
} from "./helpers";

const boot = (env: Record<string, string> = {}) => makeTestApp(env);

const fakeDiscord = (async (url: string | URL | Request) => {
	if (String(url).endsWith("/oauth2/token"))
		return Response.json({ access_token: "at" });
	return Response.json({
		id: "42",
		username: "bob",
		global_name: "Bob",
		avatar: "av",
	});
}) as typeof fetch;

const discordApp = (env: Record<string, string> = {}) =>
	makeTestApp(
		{ DISCORD_CLIENT_ID: "cid", DISCORD_CLIENT_SECRET: "s", ...env },
		fakeDiscord,
	);

/** Runs the login round trip and returns where the callback sends the browser. */
async function loginRedirect(
	t: ReturnType<typeof discordApp>,
	returnTo: string,
) {
	const start = await t.app.request(
		`/auth/discord?returnTo=${encodeURIComponent(returnTo)}`,
	);
	const state = new URL(
		start.headers.get("location") as string,
	).searchParams.get("state");
	const stateCookie = (start.headers.get("set-cookie") as string).split(
		";",
	)[0] as string;
	const cb = await t.app.request(
		`/auth/discord/callback?code=c&state=${state}`,
		{
			headers: { Cookie: stateCookie },
		},
	);
	expect(cb.status).toBe(302);
	return cb.headers.get("location");
}

describe("setup", () => {
	test("creates the map with four dimensions and is idempotent", async () => {
		const { app, db, env } = boot();
		runSetup(db, env);
		runSetup(db, env);
		expect(await db.select().from(mapInfo)).toHaveLength(1);

		const res = await app.request("/api/map");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.map.tileSize).toBe(512);
		expect(body.dimensions.map((d: { slug: string }) => d.slug)).toEqual([
			"overworld",
			"overworld_caves",
			"nether",
			"the_end",
		]);
		// Coordinate scales: overworld-like 1, the Nether 8, the End unrelated.
		expect(
			Object.fromEntries(
				body.dimensions.map((d: { slug: string; scale: number | null }) => [
					d.slug,
					d.scale,
				]),
			),
		).toEqual({ overworld: 1, overworld_caves: 1, nether: 8, the_end: null });
		expect(body.role).toBe("viewer");
		expect(body.limits).toEqual({
			maxUploadBytes: 200 * 1024 * 1024,
			maxFilesPerUpload: 2000,
		});
	});

	test("pending owners become owners on first login", async () => {
		const { db } = boot({ SETUP_OWNER_DISCORD_IDS: "111, 222" });
		expect(await db.select().from(pendingOwners)).toHaveLength(2);

		await upsertUser(db, { id: "111", username: "alice", avatar: null });
		const rows = await db.select().from(members);
		expect(rows).toEqual([
			expect.objectContaining({ userId: "111", role: "owner" }),
		]);
		expect(await db.select().from(pendingOwners)).toHaveLength(1);

		await upsertUser(db, { id: "111", username: "alice2", avatar: "abc" });
		expect(await db.select().from(members)).toHaveLength(1);
	});
});

describe("auth", () => {
	test("/api/me anonymous, bearer token and session cookie", async () => {
		const { app, db } = boot();
		const u = await makeUser(db, "1", "alice");

		expect((await (await app.request("/api/me")).json()).user).toBeNull();
		const viaToken = await app.request("/api/me", { headers: u.auth });
		expect((await viaToken.json()).user.username).toBe("alice");

		const cookie = await makeSessionCookie(db, "1");
		const viaCookie = await app.request("/api/me", {
			headers: { Cookie: cookie },
		});
		expect((await viaCookie.json()).user.id).toBe("1");

		const bad = await app.request("/api/me", {
			headers: { Authorization: "Bearer aomc_nope" },
		});
		expect(bad.status).toBe(401);
	});

	test("cookie auth requires matching Origin on writes; bearer does not", async () => {
		const { app, db } = boot();
		await makeUser(db, "1");
		const cookie = await makeSessionCookie(db, "1");
		const body = json({ name: "script" });

		const noOrigin = await app.request("/api/tokens", {
			method: "POST",
			...body,
			headers: { ...body.headers, Cookie: cookie },
		});
		expect(noOrigin.status).toBe(403);

		const ok = await app.request("/api/tokens", {
			method: "POST",
			...body,
			headers: {
				...body.headers,
				Cookie: cookie,
				Origin: "http://localhost:3000",
			},
		});
		expect(ok.status).toBe(201);
	});

	test("logout destroys the session", async () => {
		const { app, db } = boot();
		await makeUser(db, "1");
		const cookie = await makeSessionCookie(db, "1");
		const headers = { Cookie: cookie, Origin: "http://localhost:3000" };
		await app.request("/auth/logout", { method: "POST", headers });
		const me = await app.request("/api/me", { headers: { Cookie: cookie } });
		expect((await me.json()).user).toBeNull();
	});

	test("discord redirect and callback with a fake Discord", async () => {
		const t = discordApp({ SETUP_OWNER_DISCORD_IDS: "42" });

		const start = await t.app.request("/auth/discord?returnTo=/foo");
		expect(start.status).toBe(302);
		const location = new URL(start.headers.get("location") as string);
		const state = location.searchParams.get("state") as string;
		expect(location.searchParams.get("scope")).toBe("identify");
		const stateCookie = (start.headers.get("set-cookie") as string).split(
			";",
		)[0] as string;

		const wrong = await t.app.request(
			"/auth/discord/callback?code=c&state=bad",
			{
				headers: { Cookie: stateCookie },
			},
		);
		expect(wrong.status).toBe(400);

		const cb = await t.app.request(
			`/auth/discord/callback?code=c&state=${state}`,
			{
				headers: { Cookie: stateCookie },
			},
		);
		expect(cb.status).toBe(302);
		expect(cb.headers.get("location")).toBe("/foo");
		const session = cb.headers.get("set-cookie") as string;
		const sessionCookie = /aomc_session=[^;]+/.exec(session)?.[0] as string;

		const me = await t.app.request("/api/me", {
			headers: { Cookie: sessionCookie },
		});
		expect((await me.json()).user).toEqual({
			id: "42",
			username: "Bob",
			avatarUrl: "https://cdn.discordapp.com/avatars/42/av.png",
		});
		const [member] = await t.db
			.select()
			.from(members)
			.where(eq(members.userId, "42"));
		expect(member?.role).toBe("owner");
	});

	test("returnTo cannot point off-site", async () => {
		const t = discordApp();
		expect(await loginRedirect(t, "/some/page?x=1")).toBe("/some/page?x=1");
		for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com"]) {
			expect(await loginRedirect(t, bad)).toBe("/");
		}
	});
});

describe("api tokens", () => {
	const ORIGIN = "http://localhost:3000";

	async function sessionUser(id = "1") {
		const t = boot();
		const u = await makeUser(t.db, id);
		const cookie = await makeSessionCookie(t.db, id);
		const headers = {
			Cookie: cookie,
			Origin: ORIGIN,
			"Content-Type": "application/json",
		};
		return { ...t, u, headers };
	}

	test("create, use, list and delete", async () => {
		const { app, u, headers } = await sessionUser();
		const created = await app.request("/api/tokens", {
			method: "POST",
			body: JSON.stringify({ name: "script" }),
			headers,
		});
		expect(created.status).toBe(201);
		const { id, token, expiresAt } = await created.json();
		expect(token.startsWith("aomc_")).toBe(true);
		const days = (expiresAt - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(179.9);
		expect(days).toBeLessThan(180.1);

		const me = await app.request("/api/me", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect((await me.json()).user.id).toBe("1");

		const list = await (
			await app.request("/api/tokens", { headers: u.auth })
		).json();
		expect(list.tokens).toHaveLength(2);
		expect(JSON.stringify(list)).not.toContain(token);

		const del = await app.request(`/api/tokens/${id}`, {
			method: "DELETE",
			headers,
		});
		expect(del.status).toBe(200);
		const after = await app.request("/api/me", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(after.status).toBe(401);
	});

	test("expiry can be chosen, or disabled with null", async () => {
		const { app, headers } = await sessionUser();
		const post = async (body: unknown) =>
			app.request("/api/tokens", {
				method: "POST",
				body: JSON.stringify(body),
				headers,
			});
		const week = await (await post({ name: "a", expiresInDays: 7 })).json();
		expect((week.expiresAt - Date.now()) / 86_400_000).toBeCloseTo(7, 1);
		const never = await (await post({ name: "b", expiresInDays: null })).json();
		expect(never.expiresAt).toBeNull();
		expect((await post({ name: "c", expiresInDays: 0 })).status).toBe(400);
	});

	test("an expired token is rejected", async () => {
		const { app, db, headers } = await sessionUser();
		const created = await (
			await app.request("/api/tokens", {
				method: "POST",
				body: JSON.stringify({ name: "short" }),
				headers,
			})
		).json();
		const auth = { Authorization: `Bearer ${created.token}` };
		expect((await app.request("/api/me", { headers: auth })).status).toBe(200);
		await db
			.update(apiTokens)
			.set({ expiresAt: Date.now() - 1000 })
			.where(eq(apiTokens.id, created.id));
		expect((await app.request("/api/me", { headers: auth })).status).toBe(401);
	});

	test("a token cannot create or revoke tokens", async () => {
		const { app, u } = await sessionUser();
		const headers = { ...u.auth, "Content-Type": "application/json" };
		const create = await app.request("/api/tokens", {
			method: "POST",
			body: JSON.stringify({ name: "more" }),
			headers,
		});
		expect(create.status).toBe(403);
		const del = await app.request("/api/tokens/1", {
			method: "DELETE",
			headers,
		});
		expect(del.status).toBe(403);
	});

	test("the number of tokens per user is limited", async () => {
		const { app, headers } = await sessionUser();
		// makeUser already made one.
		for (let i = 1; i < MAX_TOKENS_PER_USER; i++) {
			const res = await app.request("/api/tokens", {
				method: "POST",
				body: JSON.stringify({ name: `t${i}` }),
				headers,
			});
			expect(res.status).toBe(201);
		}
		const over = await app.request("/api/tokens", {
			method: "POST",
			body: JSON.stringify({ name: "one too many" }),
			headers,
		});
		expect(over.status).toBe(409);
	});

	test("anonymous cannot list tokens", async () => {
		const { app } = boot();
		expect((await app.request("/api/tokens")).status).toBe(401);
	});
});

describe("env", () => {
	test("an https PUBLIC_URL refuses the default SESSION_SECRET", () => {
		expect(() => parseEnv({ PUBLIC_URL: "https://map.example.com" })).toThrow(
			/SESSION_SECRET/,
		);
		expect(
			parseEnv({
				PUBLIC_URL: "https://map.example.com",
				SESSION_SECRET: "x".repeat(32),
			}).PUBLIC_URL,
		).toBe("https://map.example.com");
		expect(parseEnv({ PUBLIC_URL: "http://localhost:3000" }).PORT).toBe(3000);
	});
});

describe("map", () => {
	test("the map is public: anonymous visitors can read it", async () => {
		const t = boot();
		const res = await call(t, null, "GET", "/api/map");
		expect(res.status).toBe(200);
		expect(res.body.role).toBe("viewer");
		expect(res.body.map).toMatchObject({ name: "AOMC", headRev: 0 });
	});

	test("a logged-in non-member is an editor and cannot manage dimensions", async () => {
		const t = boot();
		const bob = await makeUser(t.db, "2");
		expect((await call(t, bob, "GET", "/api/map")).body.role).toBe("editor");
		const dim = await call(t, bob, "POST", "/api/dimensions", {
			slug: "x",
			name: "X",
		});
		expect(dim.status).toBe(403);
	});

	test("only owners rename the map; PATCH {} is rejected", async () => {
		const t = boot();
		const owner = await makeUser(t.db, "owner");
		await addMember(t, "owner", "owner");
		const mod = await makeUser(t.db, "mod");
		await addMember(t, "mod", "moderator");

		expect(
			(await call(t, mod, "PATCH", "/api/map", { name: "Mine now" })).status,
		).toBe(403);
		const renamed = await call(t, owner, "PATCH", "/api/map", {
			name: "Renamed",
		});
		expect(renamed.status).toBe(200);
		expect(renamed.body.map.name).toBe("Renamed");
		expect((await call(t, owner, "PATCH", "/api/map", {})).status).toBe(400);
		expect((await call(t, null, "GET", "/api/map")).body.map.name).toBe(
			"Renamed",
		);
	});

	test("PATCH {} is rejected for dimensions and layers too", async () => {
		const t = boot();
		const mod = await makeUser(t.db, "mod");
		await addMember(t, "mod", "moderator");
		expect(
			(await call(t, mod, "PATCH", "/api/dimensions/nether", {})).status,
		).toBe(400);
		const layer = await call(t, mod, "POST", "/api/layers", {
			dimension: "overworld",
			name: "L",
		});
		expect(
			(await call(t, mod, "PATCH", `/api/layers/${layer.body.layer.id}`, {}))
				.status,
		).toBe(400);
	});

	test("a moderator manages dimensions", async () => {
		const t = boot();
		const mod = await makeUser(t.db, "3");
		await addMember(t, "3", "moderator");

		const add = await call(t, mod, "POST", "/api/dimensions", {
			slug: "custom",
			name: "Custom",
		});
		expect(add.status).toBe(201);
		const archive = await call(t, mod, "PATCH", "/api/dimensions/custom", {
			archived: true,
		});
		expect(archive.body.dimension.archived).toBe(true);
		const dup = await call(t, mod, "POST", "/api/dimensions", {
			slug: "custom",
			name: "Again",
		});
		expect(dup.status).toBe(409);
	});

	test("dimension scale can be set on creation, changed, cleared, and is validated", async () => {
		const t = boot();
		const mod = await makeUser(t.db, "3");
		await addMember(t, "3", "moderator");
		const scaleOf = async (slug: string) =>
			(await call(t, null, "GET", "/api/map")).body.dimensions.find(
				(d: { slug: string }) => d.slug === slug,
			).scale;

		// No scale given: unrelated.
		expect(
			(await call(t, mod, "POST", "/api/dimensions", { slug: "a", name: "A" }))
				.status,
		).toBe(201);
		expect(await scaleOf("a")).toBeNull();
		expect(
			(
				await call(t, mod, "POST", "/api/dimensions", {
					slug: "b",
					name: "B",
					scale: 2.5,
				})
			).status,
		).toBe(201);
		expect(await scaleOf("b")).toBe(2.5);

		expect(
			(await call(t, mod, "PATCH", "/api/dimensions/a", { scale: 16 })).status,
		).toBe(200);
		expect(await scaleOf("a")).toBe(16);
		// Other edits leave the scale alone; null clears it.
		await call(t, mod, "PATCH", "/api/dimensions/a", { name: "Renamed" });
		expect(await scaleOf("a")).toBe(16);
		await call(t, mod, "PATCH", "/api/dimensions/a", { scale: null });
		expect(await scaleOf("a")).toBeNull();

		for (const bad of [0, -1, "8", 1_000_001]) {
			expect(
				(await call(t, mod, "PATCH", "/api/dimensions/a", { scale: bad }))
					.status,
			).toBe(400);
		}
		expect(await scaleOf("a")).toBeNull();
	});
});

describe("members", () => {
	async function setup() {
		const t = boot();
		const owner = await makeUser(t.db, "1", "alice");
		await addMember(t, "1", "owner");
		const bob = await makeUser(t.db, "2", "bob");
		return { t, owner, bob };
	}

	test("only owners list and change members; roles are moderator or owner", async () => {
		const { t, owner, bob } = await setup();
		expect(
			(
				await call(t, owner, "POST", "/api/members", {
					userId: "2",
					role: "moderator",
				})
			).status,
		).toBe(201);
		expect((await call(t, bob, "GET", "/api/map")).body.role).toBe("moderator");
		expect((await call(t, bob, "GET", "/api/members")).status).toBe(403);
		expect(
			(
				await call(t, bob, "POST", "/api/members", {
					userId: "1",
					role: "owner",
				})
			).status,
		).toBe(403);
		expect((await call(t, null, "GET", "/api/members")).status).toBe(401);

		const list = await call(t, owner, "GET", "/api/members");
		expect(
			list.body.members.map((m: { userId: string; role: string }) => [
				m.userId,
				m.role,
			]),
		).toEqual(
			expect.arrayContaining([
				["1", "owner"],
				["2", "moderator"],
			]),
		);

		for (const role of ["viewer", "editor"]) {
			expect(
				(await call(t, owner, "POST", "/api/members", { userId: "2", role }))
					.status,
			).toBe(400);
		}
		expect(
			(
				await call(t, owner, "POST", "/api/members", {
					userId: "ghost",
					role: "owner",
				})
			).status,
		).toBe(404);
	});

	test("the last owner can be neither demoted nor removed", async () => {
		const { t, owner } = await setup();
		const demote = await call(t, owner, "PATCH", "/api/members/1", {
			role: "moderator",
		});
		expect(demote.status).toBe(409);
		const remove = await call(t, owner, "DELETE", "/api/members/1");
		expect(remove.status).toBe(409);
		expect(
			(
				await call(t, owner, "POST", "/api/members", {
					userId: "1",
					role: "moderator",
				})
			).status,
		).toBe(409);
		expect(await t.db.select().from(members)).toEqual([
			expect.objectContaining({ userId: "1", role: "owner" }),
		]);

		await call(t, owner, "POST", "/api/members", {
			userId: "2",
			role: "owner",
		});
		const demoteOk = await call(t, owner, "PATCH", "/api/members/1", {
			role: "moderator",
		});
		expect(demoteOk.status).toBe(200);
		expect((await call(t, owner, "GET", "/api/map")).body.role).toBe(
			"moderator",
		);
	});

	test("a moderator can step down and becomes an implicit editor", async () => {
		const { t, bob } = await setup();
		await addMember(t, "2", "moderator");
		expect((await call(t, bob, "GET", "/api/map")).body.role).toBe("moderator");

		expect((await call(t, bob, "DELETE", "/api/members/2")).status).toBe(200);
		expect(await t.db.select().from(members)).toEqual([
			expect.objectContaining({ userId: "1" }),
		]);
		expect((await call(t, bob, "GET", "/api/map")).body.role).toBe("editor");
		expect((await call(t, bob, "DELETE", "/api/members/2")).status).toBe(404);
	});

	test("a non-last owner can step down; nobody else may remove other members", async () => {
		const { t, owner, bob } = await setup();
		await addMember(t, "2", "owner");
		const carol = await makeUser(t.db, "3", "carol");
		await addMember(t, "3", "moderator");
		expect((await call(t, carol, "DELETE", "/api/members/1")).status).toBe(403);
		expect((await call(t, bob, "DELETE", "/api/members/2")).status).toBe(200);
		expect((await call(t, owner, "GET", "/api/map")).body.role).toBe("owner");
		expect((await call(t, bob, "GET", "/api/map")).body.role).toBe("editor");
	});
});

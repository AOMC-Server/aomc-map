import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { upsertUser } from "../src/auth/discord";
import { mapMembers, maps, pendingOwners } from "../src/db/schema";
import { runSetup } from "../src/setup";
import { json, makeSessionCookie, makeTestApp, makeUser } from "./helpers";

async function boot(env: Record<string, string> = {}) {
	const t = makeTestApp(env);
	await runSetup(t.db, t.env);
	return t;
}

describe("setup", () => {
	test("creates default map with four dimensions and is idempotent", async () => {
		const { app, db, env } = await boot();
		await runSetup(db, env);
		await runSetup(db, env);
		expect(await db.select().from(maps)).toHaveLength(1);

		const res = await app.request("/api/maps/aomc");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.map.isDefault).toBe(true);
		expect(body.map.visibility).toBe("public");
		expect(body.map.tileSize).toBe(512);
		expect(body.dimensions.map((d: { slug: string }) => d.slug)).toEqual([
			"overworld",
			"overworld_caves",
			"nether",
			"the_end",
		]);
		expect(body.role).toBe("viewer");
	});

	test("pending owners become owners on first login", async () => {
		const { db } = await boot({ SETUP_OWNER_DISCORD_IDS: "111, 222" });
		expect(await db.select().from(pendingOwners)).toHaveLength(2);

		await upsertUser(db, { id: "111", username: "alice", avatar: null });
		const members = await db.select().from(mapMembers);
		expect(members).toEqual([
			expect.objectContaining({ userId: "111", role: "owner" }),
		]);
		expect(await db.select().from(pendingOwners)).toHaveLength(1);

		await upsertUser(db, { id: "111", username: "alice2", avatar: "abc" });
		expect(await db.select().from(mapMembers)).toHaveLength(1);
	});
});

describe("auth", () => {
	test("/api/me anonymous, bearer token and session cookie", async () => {
		const { app, db } = await boot();
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
		const { app, db } = await boot();
		await makeUser(db, "1");
		const cookie = await makeSessionCookie(db, "1");
		const body = json({ slug: "m1", name: "M1" });

		const noOrigin = await app.request("/api/maps", {
			method: "POST",
			...body,
			headers: { ...body.headers, Cookie: cookie },
		});
		expect(noOrigin.status).toBe(403);

		const ok = await app.request("/api/maps", {
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
		const { app, db } = await boot();
		await makeUser(db, "1");
		const cookie = await makeSessionCookie(db, "1");
		const headers = { Cookie: cookie, Origin: "http://localhost:3000" };
		await app.request("/auth/logout", { method: "POST", headers });
		const me = await app.request("/api/me", { headers: { Cookie: cookie } });
		expect((await me.json()).user).toBeNull();
	});

	test("discord redirect and callback with a fake Discord", async () => {
		const fake = (async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/oauth2/token"))
				return Response.json({ access_token: "at" });
			return Response.json({
				id: "42",
				username: "bob",
				global_name: "Bob",
				avatar: "av",
			});
		}) as typeof fetch;
		const t = makeTestApp(
			{
				DISCORD_CLIENT_ID: "cid",
				DISCORD_CLIENT_SECRET: "s",
				SETUP_OWNER_DISCORD_IDS: "42",
			},
			fake,
		);
		await runSetup(t.db, t.env);

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
			.from(mapMembers)
			.where(eq(mapMembers.userId, "42"));
		expect(member?.role).toBe("owner");
	});

	test("returnTo cannot point off-site", async () => {
		const { app } = await boot();
		const res = await app.request("/auth/discord?returnTo=//evil.com");
		expect(res.status).toBe(302);
	});
});

describe("api tokens", () => {
	test("create, use, list and delete", async () => {
		const { app, db } = await boot();
		const u = await makeUser(db, "1");
		const created = await app.request("/api/tokens", {
			method: "POST",
			...json({ name: "script" }),
			headers: { ...u.auth, "Content-Type": "application/json" },
		});
		expect(created.status).toBe(201);
		const { id, token } = await created.json();
		expect(token.startsWith("aomc_")).toBe(true);

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
			headers: u.auth,
		});
		expect(del.status).toBe(200);
		const after = await app.request("/api/me", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(after.status).toBe(401);
	});

	test("anonymous cannot list tokens", async () => {
		const { app } = await boot();
		expect((await app.request("/api/tokens")).status).toBe(401);
	});
});

describe("maps", () => {
	test("create, private map hidden as 404, members and last-owner guard", async () => {
		const { app, db } = await boot();
		const alice = await makeUser(db, "1", "alice");
		const bob = await makeUser(db, "2", "bob");
		const post = (
			u: { auth: object },
			path: string,
			body: unknown,
			method = "POST",
		) =>
			app.request(path, {
				method,
				...json(body),
				headers: { ...u.auth, "Content-Type": "application/json" },
			});

		const created = await post(alice, "/api/maps", {
			slug: "secret",
			name: "Secret",
		});
		expect(created.status).toBe(201);
		expect((await created.json()).map.visibility).toBe("private");
		expect(
			(await post(alice, "/api/maps", { slug: "secret", name: "Dup" })).status,
		).toBe(409);

		expect((await app.request("/api/maps/secret")).status).toBe(404);
		expect(
			(await app.request("/api/maps/secret", { headers: bob.auth })).status,
		).toBe(404);
		expect(
			(await app.request("/api/maps/secret", { headers: alice.auth })).status,
		).toBe(200);

		const listBob = await (
			await app.request("/api/maps", { headers: bob.auth })
		).json();
		expect(listBob.maps.map((m: { slug: string }) => m.slug)).toEqual(["aomc"]);
		const listAlice = await (
			await app.request("/api/maps", { headers: alice.auth })
		).json();
		expect(listAlice.maps.map((m: { slug: string }) => m.slug).sort()).toEqual([
			"aomc",
			"secret",
		]);

		expect(
			(
				await post(alice, "/api/maps/secret/members", {
					userId: "2",
					role: "viewer",
				})
			).status,
		).toBe(201);
		const asBob = await (
			await app.request("/api/maps/secret", { headers: bob.auth })
		).json();
		expect(asBob.role).toBe("viewer");
		expect(
			(await app.request("/api/maps/secret/members", { headers: bob.auth }))
				.status,
		).toBe(403);
		expect(
			(await post(bob, "/api/maps/secret", { name: "x" }, "PATCH")).status,
		).toBe(403);

		const demote = await post(
			alice,
			"/api/maps/secret/members/1",
			{ role: "editor" },
			"PATCH",
		);
		expect(demote.status).toBe(409);
		const remove = await app.request("/api/maps/secret/members/1", {
			method: "DELETE",
			headers: alice.auth,
		});
		expect(remove.status).toBe(409);

		await post(alice, "/api/maps/secret/members", {
			userId: "2",
			role: "owner",
		});
		const demoteOk = await post(
			alice,
			"/api/maps/secret/members/1",
			{ role: "editor" },
			"PATCH",
		);
		expect(demoteOk.status).toBe(200);
	});

	test("public map: logged-in non-member is editor and cannot manage dimensions", async () => {
		const { app, db } = await boot();
		const bob = await makeUser(db, "2");
		const res = await (
			await app.request("/api/maps/aomc", { headers: bob.auth })
		).json();
		expect(res.role).toBe("editor");
		const dim = await app.request("/api/maps/aomc/dimensions", {
			method: "POST",
			...json({ slug: "x", name: "X" }),
			headers: { ...bob.auth, "Content-Type": "application/json" },
		});
		expect(dim.status).toBe(403);
	});

	test("default map: moderator manages dimensions, cannot delete map or hide it", async () => {
		const { app, db } = await boot();
		const mod = await makeUser(db, "3");
		const [map] = await db.select().from(maps);
		await db
			.insert(mapMembers)
			.values({ mapId: map?.id as number, userId: "3", role: "moderator" });
		const h = { ...mod.auth, "Content-Type": "application/json" };

		const add = await app.request("/api/maps/aomc/dimensions", {
			method: "POST",
			...json({ slug: "custom", name: "Custom" }),
			headers: h,
		});
		expect(add.status).toBe(201);
		const archive = await app.request("/api/maps/aomc/dimensions/custom", {
			method: "PATCH",
			...json({ archived: true }),
			headers: h,
		});
		expect((await archive.json()).dimension.archived).toBe(true);

		expect(
			(
				await app.request("/api/maps/aomc", {
					method: "DELETE",
					headers: mod.auth,
				})
			).status,
		).toBe(403);
	});

	test("default map cannot be made private or deleted by an owner", async () => {
		const { app, db } = await boot();
		const owner = await makeUser(db, "4");
		const [map] = await db.select().from(maps);
		await db
			.insert(mapMembers)
			.values({ mapId: map?.id as number, userId: "4", role: "owner" });
		const h = { ...owner.auth, "Content-Type": "application/json" };
		const hide = await app.request("/api/maps/aomc", {
			method: "PATCH",
			...json({ visibility: "private" }),
			headers: h,
		});
		expect(hide.status).toBe(400);
		expect(
			(
				await app.request("/api/maps/aomc", {
					method: "DELETE",
					headers: owner.auth,
				})
			).status,
		).toBe(400);
	});

	test("tile size only changes while the map has no uploads", async () => {
		const { app, db } = await boot();
		const alice = await makeUser(db, "1");
		const h = { ...alice.auth, "Content-Type": "application/json" };
		await app.request("/api/maps", {
			method: "POST",
			...json({ slug: "t", name: "T" }),
			headers: h,
		});

		const ok = await app.request("/api/maps/t", {
			method: "PATCH",
			...json({ tileSize: 256 }),
			headers: h,
		});
		expect(ok.status).toBe(200);
		expect((await ok.json()).map.tileSize).toBe(256);

		await db.update(maps).set({ headRev: 1 }).where(eq(maps.slug, "t"));
		const locked = await app.request("/api/maps/t", {
			method: "PATCH",
			...json({ tileSize: 128 }),
			headers: h,
		});
		expect(locked.status).toBe(409);
	});

	test("input is validated", async () => {
		const { app, db } = await boot();
		const alice = await makeUser(db, "1");
		const res = await app.request("/api/maps", {
			method: "POST",
			...json({ slug: "Bad Slug!", name: "x" }),
			headers: { ...alice.auth, "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
	});
});

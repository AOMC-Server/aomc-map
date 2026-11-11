import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
	SESSION_COOKIE,
	SESSION_TTL_MS,
	sessionCookieOptions,
} from "../src/auth/session";
import { sha256Hex } from "../src/auth/tokens";
import { apiTokens, sessions } from "../src/db/schema";
import { parseEnv } from "../src/env";
import { safeReturnTo } from "../src/routes/auth";
import {
	call,
	cleanupTempDirs,
	makeSessionCookie,
	makeTestApp,
	makeUser,
} from "./helpers";

afterAll(cleanupTempDirs);

const ORIGIN = "http://localhost:3000";

const fakeDiscord = (async (url: string | URL | Request) => {
	if (String(url).endsWith("/oauth2/token"))
		return Response.json({ access_token: "at" });
	return Response.json({ id: "42", username: "bob", avatar: null });
}) as typeof fetch;

const discordApp = () =>
	makeTestApp(
		{ DISCORD_CLIENT_ID: "cid", DISCORD_CLIENT_SECRET: "s" },
		fakeDiscord,
	);

/** Runs the whole login round trip; returns the callback response. */
async function login(
	t: ReturnType<typeof discordApp>,
	returnTo: string,
	cookie = "",
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
	return t.app.request(`/auth/discord/callback?code=c&state=${state}`, {
		headers: { Cookie: [stateCookie, cookie].filter(Boolean).join("; ") },
	});
}

describe("safeReturnTo", () => {
	const safe: [string, string][] = [
		["/", "/"],
		["/some/page?x=1#top", "/some/page?x=1#top"],
		["/invite/abc?accept=1", "/invite/abc?accept=1"],
		["/a|b", "/a|b"],
	];
	for (const [input, expected] of safe) {
		test(`keeps ${JSON.stringify(input)}`, () =>
			expect(safeReturnTo(input, ORIGIN)).toBe(expected));
	}

	const unsafe = [
		undefined,
		"",
		"foo",
		"//evil.com",
		"/\\evil.com",
		"/\tevil.com",
		"/\t/evil.com",
		"/\n/evil.com",
		"/\r/evil.com",
		"/\0/evil.com",
		"\t//evil.com",
		"/a\\b",
		"https://evil.com",
		"javascript:alert(1)",
	];
	for (const input of unsafe) {
		test(`rejects ${JSON.stringify(input)}`, () =>
			expect(safeReturnTo(input, ORIGIN)).toBe("/"));
	}

	test("percent-encoded tricks stay on this origin", () => {
		for (const input of ["/%09/evil.com", "/%2F/evil.com", "/%5Cevil.com"]) {
			const out = safeReturnTo(input, ORIGIN);
			expect(out.startsWith("//")).toBe(false);
			expect(new URL(out, ORIGIN).origin).toBe(ORIGIN);
		}
	});

	test("a pipe survives the state cookie round trip", async () => {
		const t = discordApp();
		const cb = await login(t, "/page?a=1|b=2");
		expect(cb.status).toBe(302);
		expect(cb.headers.get("location")).toBe("/page?a=1|b=2");
	});

	test("hostile values redirect to / through the real endpoint", async () => {
		const t = discordApp();
		for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\\evil.com"]) {
			const cb = await login(t, bad);
			expect(cb.headers.get("location")).toBe("/");
		}
	});
});

describe("sessions", () => {
	test("logging in destroys the session of the previous cookie", async () => {
		const t = discordApp();
		await makeUser(t.db, "old");
		const oldValue = (await makeSessionCookie(t.db, "old")).split("=")[1];
		const before = await t.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sha256Hex(oldValue as string)));
		expect(before).toHaveLength(1);

		const cb = await login(t, "/", `${SESSION_COOKIE}=${oldValue}`);
		expect(cb.status).toBe(302);
		const after = await t.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sha256Hex(oldValue as string)));
		expect(after).toHaveLength(0);
		expect(cb.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
	});

	test("a refreshed session re-sends its cookie with a fresh lifetime", async () => {
		const t = makeTestApp();
		await makeUser(t.db, "1");
		const cookie = await makeSessionCookie(t.db, "1");
		const id = sha256Hex(cookie.split("=")[1] as string);

		const fresh = await t.app.request("/api/me", {
			headers: { Cookie: cookie },
		});
		expect(fresh.headers.get("set-cookie")).toBeNull();

		const aged = Date.now() + 5 * 60_000;
		await t.db
			.update(sessions)
			.set({ expiresAt: aged })
			.where(eq(sessions.id, id));
		const res = await t.app.request("/api/me", { headers: { Cookie: cookie } });
		expect((await res.json()).user.id).toBe("1");
		const set = res.headers.get("set-cookie") as string;
		expect(set).toContain(cookie);
		expect(set).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
		const [row] = await t.db.select().from(sessions).where(eq(sessions.id, id));
		expect(row?.expiresAt).toBeGreaterThan(
			Date.now() + SESSION_TTL_MS - 60_000,
		);
	});

	test("cookies are Secure only for an https PUBLIC_URL", () => {
		const http = parseEnv({ PUBLIC_URL: ORIGIN });
		const https = parseEnv({
			PUBLIC_URL: "https://map.example.com",
			SESSION_SECRET: "x".repeat(32),
		});
		expect(sessionCookieOptions(http).secure).toBe(false);
		expect(sessionCookieOptions(https).secure).toBe(true);
	});
});

describe("api tokens", () => {
	test("a token cannot list tokens; a session can", async () => {
		const t = makeTestApp();
		const u = await makeUser(t.db, "1");
		const res = await call(t, u, "GET", "/api/tokens");
		expect(res.status).toBe(403);
		const cookie = await makeSessionCookie(t.db, "1");
		const ok = await t.app.request("/api/tokens", {
			headers: { Cookie: cookie },
		});
		expect(ok.status).toBe(200);
		expect((await ok.json()).tokens).toHaveLength(1);
	});

	test("a malformed token id is a 404", async () => {
		const t = makeTestApp();
		await makeUser(t.db, "1");
		const res = await t.app.request("/api/tokens/1abc", {
			method: "DELETE",
			headers: { Cookie: await makeSessionCookie(t.db, "1"), Origin: ORIGIN },
		});
		expect(res.status).toBe(404);
	});

	test("lastUsedAt is written at most once a minute", async () => {
		const t = makeTestApp();
		const u = await makeUser(t.db, "1");
		const lastUsed = async () =>
			(await t.db.select().from(apiTokens))[0]?.lastUsedAt ?? null;
		expect(await lastUsed()).toBeNull();

		await call(t, u, "GET", "/api/me");
		const first = await lastUsed();
		expect(first).not.toBeNull();
		await call(t, u, "GET", "/api/me");
		expect(await lastUsed()).toBe(first);

		await t.db.update(apiTokens).set({ lastUsedAt: Date.now() - 120_000 });
		await call(t, u, "GET", "/api/me");
		expect((await lastUsed()) as number).toBeGreaterThan(Date.now() - 10_000);
	});
});

describe("env", () => {
	test("the dev SESSION_SECRET is refused in production", () => {
		expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(
			/SESSION_SECRET/,
		);
		expect(
			parseEnv({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) }).PORT,
		).toBe(3000);
		expect(parseEnv({ NODE_ENV: "development" }).PORT).toBe(3000);
	});

	test("tile size must be a positive even integer", () => {
		for (const bad of ["0", "-512", "511", "1.5", "abc"]) {
			expect(() => parseEnv({ DEFAULT_TILE_SIZE: bad })).toThrow();
		}
		expect(parseEnv({ DEFAULT_TILE_SIZE: "256" }).DEFAULT_TILE_SIZE).toBe(256);
	});

	test("MAX_ZOOM is a small non-negative integer", () => {
		for (const bad of ["-1", "13", "2.5", "x"]) {
			expect(() => parseEnv({ MAX_ZOOM: bad })).toThrow();
		}
		expect(parseEnv({ MAX_ZOOM: "0" }).MAX_ZOOM).toBe(0);
		expect(parseEnv({ MAX_ZOOM: "12" }).MAX_ZOOM).toBe(12);
	});
});

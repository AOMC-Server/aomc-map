import { Hono } from "hono";
import {
	deleteCookie,
	getCookie,
	getSignedCookie,
	setCookie,
	setSignedCookie,
} from "hono/cookie";
import { authorizeUrl, fetchProfile, upsertUser } from "../auth/discord";
import {
	createSession,
	destroySession,
	SESSION_COOKIE,
	sessionCookieOptions,
} from "../auth/session";
import { randomToken } from "../auth/tokens";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

const STATE_COOKIE = "aomc_oauth";

/**
 * Only allow same-site paths as post-login redirect targets. The value is resolved against
 * PUBLIC_URL and rebuilt from the result, so what is sent to the browser cannot name another host.
 */
export function safeReturnTo(
	value: string | undefined,
	publicUrl: string,
): string {
	// Browsers drop tabs and newlines inside URLs, and treat backslashes as slashes.
	if (!value?.startsWith("/") || /[\p{Cc}\\]/u.test(value)) return "/";
	try {
		const base = new URL(publicUrl);
		const url = new URL(value, base);
		if (url.origin !== base.origin) return "/";
		return url.pathname + url.search + url.hash;
	} catch {
		return "/";
	}
}

export type DiscordFetch = typeof fetch;

export function authRoutes(fetchFn: DiscordFetch = fetch) {
	return new Hono<AppEnv>()
		.get(
			"/discord",
			doc({
				tag: "Session",
				summary: "Start the Discord login",
				description:
					"Redirects to Discord. `returnTo` must be a same-site relative path.",
				ok: { 302: "Redirect to Discord" },
				query: { returnTo: "Path to return to after login" },
			}),
			async (c) => {
				const env = c.var.env;
				const state = randomToken(16);
				const returnTo = safeReturnTo(c.req.query("returnTo"), env.PUBLIC_URL);
				await setSignedCookie(
					c,
					STATE_COOKIE,
					`${state}|${returnTo}`,
					env.SESSION_SECRET,
					{
						httpOnly: true,
						sameSite: "Lax",
						secure: env.COOKIE_SECURE,
						path: "/auth",
						maxAge: 600,
					},
				);
				return c.redirect(authorizeUrl(env, state));
			},
		)
		.get(
			"/discord/callback",
			doc({
				tag: "Session",
				summary: "Finish the Discord login",
				description:
					"Sets the session cookie and redirects. Discord sends the browser here.",
				ok: { 302: "Logged in; redirect to the return path" },
				fails: [400, 502],
				query: { code: "OAuth code", state: "OAuth state" },
			}),
			async (c) => {
				const env = c.var.env;
				const stored = await getSignedCookie(
					c,
					env.SESSION_SECRET,
					STATE_COOKIE,
				);
				deleteCookie(c, STATE_COOKIE, { path: "/auth" });
				// The state is base64url, so the first `|` ends it; returnTo may contain more.
				const sep = stored ? stored.indexOf("|") : -1;
				const state = stored && sep >= 0 ? stored.slice(0, sep) : "";
				const returnTo = stored && sep >= 0 ? stored.slice(sep + 1) : "";
				const code = c.req.query("code");
				if (!stored || !state || state !== c.req.query("state") || !code) {
					return c.json({ error: "invalid oauth state" }, 400);
				}
				let profile: Awaited<ReturnType<typeof fetchProfile>>;
				try {
					profile = await fetchProfile(env, code, fetchFn);
				} catch (err) {
					console.error(err);
					return c.json({ error: "discord login failed" }, 502);
				}
				upsertUser(c.var.db, profile);
				const previous = getCookie(c, SESSION_COOKIE);
				if (previous) await destroySession(c.var.db, previous);
				const session = await createSession(c.var.db, profile.id);
				setCookie(c, SESSION_COOKIE, session, sessionCookieOptions(env));
				return c.redirect(safeReturnTo(returnTo, env.PUBLIC_URL));
			},
		)
		.post("/logout", doc({ tag: "Session", summary: "Log out" }), async (c) => {
			const cookie = getCookie(c, SESSION_COOKIE);
			if (cookie) await destroySession(c.var.db, cookie);
			deleteCookie(c, SESSION_COOKIE, { path: "/" });
			return c.json({ ok: true });
		});
}

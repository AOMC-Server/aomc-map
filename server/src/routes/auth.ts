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
	SESSION_TTL_MS,
} from "../auth/session";
import { randomToken } from "../auth/tokens";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

const STATE_COOKIE = "aomc_oauth";

/** Only allow same-site relative paths as post-login redirect targets. */
function safeReturnTo(value: string | undefined): string {
	if (
		value?.startsWith("/") &&
		!value.startsWith("//") &&
		!value.startsWith("/\\")
	)
		return value;
	return "/";
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
				const returnTo = safeReturnTo(c.req.query("returnTo"));
				await setSignedCookie(
					c,
					STATE_COOKIE,
					`${state}|${returnTo}`,
					env.SESSION_SECRET,
					{
						httpOnly: true,
						sameSite: "Lax",
						secure: env.PUBLIC_URL.startsWith("https:"),
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
				const [state, returnTo] = (stored || "").split("|");
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
				const session = await createSession(c.var.db, profile.id);
				setCookie(c, SESSION_COOKIE, session, {
					httpOnly: true,
					sameSite: "Lax",
					secure: env.PUBLIC_URL.startsWith("https:"),
					path: "/",
					maxAge: SESSION_TTL_MS / 1000,
				});
				return c.redirect(safeReturnTo(returnTo));
			},
		)
		.post("/logout", doc({ tag: "Session", summary: "Log out" }), async (c) => {
			const cookie = getCookie(c, SESSION_COOKIE);
			if (cookie) await destroySession(c.var.db, cookie);
			deleteCookie(c, SESSION_COOKIE, { path: "/" });
			return c.json({ ok: true });
		});
}

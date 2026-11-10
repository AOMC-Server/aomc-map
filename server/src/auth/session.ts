import { eq, lt } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";
import type { AppEnv, User } from "../types";
import { randomToken, sha256Hex, verifyApiToken } from "./tokens";

export const SESSION_COOKIE = "aomc_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** Returns the cookie value; only its hash is stored. */
export async function createSession(db: Db, userId: string): Promise<string> {
	const value = randomToken(32);
	await db.insert(sessions).values({
		id: sha256Hex(value),
		userId,
		expiresAt: Date.now() + SESSION_TTL_MS,
	});
	await db.delete(sessions).where(lt(sessions.expiresAt, Date.now()));
	return value;
}

export async function validateSession(
	db: Db,
	value: string,
): Promise<User | null> {
	const id = sha256Hex(value);
	const [row] = await db
		.select({
			expiresAt: sessions.expiresAt,
			id: users.id,
			username: users.username,
			avatarUrl: users.avatarUrl,
		})
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(eq(sessions.id, id));
	if (!row) return null;
	const now = Date.now();
	if (row.expiresAt <= now) {
		await destroySession(db, value);
		return null;
	}
	// Sliding expiry, written at most once a day.
	if (row.expiresAt - now < SESSION_TTL_MS - REFRESH_AFTER_MS) {
		await db
			.update(sessions)
			.set({ expiresAt: now + SESSION_TTL_MS })
			.where(eq(sessions.id, id));
	}
	return { id: row.id, username: row.username, avatarUrl: row.avatarUrl };
}

export async function destroySession(db: Db, value: string) {
	await db.delete(sessions).where(eq(sessions.id, sha256Hex(value)));
}

/** Sets c.var.user from a Bearer token or the session cookie, and enforces the Origin check for cookie auth. */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const db = c.var.db;
	const header = c.req.header("Authorization");
	c.set("user", null);
	c.set("authVia", null);

	if (header?.startsWith("Bearer ")) {
		const user = await verifyApiToken(db, header.slice(7).trim());
		if (!user) return c.json({ error: "invalid token" }, 401);
		c.set("user", user);
		c.set("authVia", "token");
		return next();
	}

	const cookie = getCookie(c, SESSION_COOKIE);
	if (cookie) {
		const user = await validateSession(db, cookie);
		if (user) {
			const method = c.req.method;
			if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
				const origin = c.req.header("Origin");
				if (origin !== new URL(c.var.env.PUBLIC_URL).origin) {
					return c.json({ error: "bad origin" }, 403);
				}
			}
			c.set("user", user);
			c.set("authVia", "session");
		}
	}
	return next();
});

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.var.user) return c.json({ error: "unauthorized" }, 401);
	return next();
});

import type { Role, TokenScope } from "@aomc/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isRead = (method: string) => READ_METHODS.has(method);

/**
 * The scope a token needs for a write to `path`. Writes not listed here are session only, so a
 * new endpoint stays out of reach of tokens until it is given a scope.
 */
const WRITE_SCOPES: [RegExp, TokenScope][] = [
	[/^\/api\/dimensions\/[^/]+\/uploads\/?$/, "upload"],
	[/^\/api\/revisions\/[^/]+\/?$/, "upload"],
	[/^\/api\/dimensions(\/[^/]+)?\/?$/, "moderate"],
	[/^\/api\/layers(\/.*)?$/, "features"],
	[/^\/api\/features(\/.*)?$/, "features"],
	// Revoking: layer invites need `features`; map invites need an owner, which needs `manage`.
	[/^\/api\/invites\/\d+\/?$/, "features"],
	[/^\/api\/invites\/[^/]+\/accept\/?$/, "features"],
	[/^\/api\/invites\/?$/, "manage"],
	[/^\/api\/members(\/.*)?$/, "manage"],
	[/^\/api\/map\/?$/, "manage"],
];

export function writeScopeFor(path: string): TokenScope | null {
	for (const [pattern, scope] of WRITE_SCOPES) {
		if (pattern.test(path)) return scope;
	}
	return null;
}

/** The highest role a token's scopes let it act with when writing. */
export function roleCap(scopes: readonly TokenScope[]): Role {
	if (scopes.includes("manage")) return "owner";
	if (scopes.includes("moderate")) return "moderator";
	return "editor";
}

/** Endpoints that answer as the token's user even without `read`. */
const IDENTITY_PATHS = new Set(["/api/me", "/api/me/"]);

/**
 * For token requests: GETs without `read` are answered as to an anonymous visitor, and writes
 * need the scope of their endpoint. Runs after authMiddleware.
 */
export const scopeMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const scopes = c.var.scopes;
	if (c.var.authVia !== "token" || !scopes) return next();

	if (isRead(c.req.method)) {
		if (!scopes.includes("read") && !IDENTITY_PATHS.has(c.req.path)) {
			c.set("user", null);
			c.set("authVia", null);
		}
		return next();
	}

	if (!c.req.path.startsWith("/api/")) return next();
	// Token management checks for a session itself, with a clearer message.
	if (/^\/api\/tokens(\/.*)?$/.test(c.req.path)) return next();
	const needed = writeScopeFor(c.req.path);
	if (!needed) {
		return c.json({ error: "this endpoint needs a browser session" }, 403);
	}
	if (!scopes.includes(needed)) {
		return c.json({ error: `this token lacks the "${needed}" scope` }, 403);
	}
	return next();
});

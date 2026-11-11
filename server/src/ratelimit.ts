import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { isRead } from "./auth/scopes";
import type { AppEnv } from "./types";

/** Fixed-window in-memory limiter. `hit` returns false once the key is over its limit. */
export function createRateLimiter(limit: number, windowMs = 60_000) {
	const windows = new Map<string, { start: number; count: number }>();
	return {
		hit(key: string, now = Date.now()): boolean {
			const w = windows.get(key);
			if (!w || now - w.start >= windowMs) {
				windows.set(key, { start: now, count: 1 });
				if (windows.size > 10_000) {
					for (const [k, v] of windows)
						if (now - v.start >= windowMs) windows.delete(k);
				}
				return true;
			}
			w.count++;
			return w.count <= limit;
		},
	};
}

/** Layer, feature and sharing writes per user per minute. */
export const WRITE_RATE_LIMIT = 120;
/** Link-preview renders per client per minute (cached pictures are free). */
export const PREVIEW_RATE_LIMIT = 30;

export const limitWrites = createMiddleware<AppEnv>(async (c, next) => {
	const { user, svc } = c.var;
	if (user && !isRead(c.req.method) && !svc.writeLimiter.hit(user.id))
		return c.json({ error: "too many changes, slow down" }, 429);
	await next();
});

/**
 * Who is asking, for limits on anonymous requests: the address the reverse proxy saw (the last
 * `X-Forwarded-For` entry, which is the one the proxy added), else the connection's address.
 */
export function clientKey(c: Context): string {
	const forwarded = c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim();
	if (forwarded) return forwarded;
	const server = c.env as
		| { requestIP?: (req: Request) => { address: string } | null }
		| undefined;
	return server?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

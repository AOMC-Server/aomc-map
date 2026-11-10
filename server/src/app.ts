import { Hono } from "hono";
import { authMiddleware } from "./auth/session";
import type { Db } from "./db/client";
import type { Env } from "./env";
import { authRoutes } from "./routes/auth";
import { mapRoutes } from "./routes/maps";
import { meRoutes } from "./routes/me";
import { tokenRoutes } from "./routes/tokens";
import type { AppEnv } from "./types";

export type AppDeps = { db: Db; env: Env; fetch?: typeof fetch };

export function createApp({ db, env, fetch: fetchFn }: AppDeps) {
	return new Hono<AppEnv>()
		.use(async (c, next) => {
			c.set("db", db);
			c.set("env", env);
			await next();
		})
		.use(authMiddleware)
		.route("/auth", authRoutes(fetchFn))
		.route("/api/me", meRoutes)
		.route("/api/tokens", tokenRoutes)
		.route("/api/maps", mapRoutes);
}

export type AppType = ReturnType<typeof createApp>;

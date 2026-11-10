import { Hono } from "hono";
import { authMiddleware } from "./auth/session";
import type { Db } from "./db/client";
import type { Env } from "./env";
import { authRoutes } from "./routes/auth";
import { blobRoutes } from "./routes/blobs";
import { mapRoutes } from "./routes/maps";
import { meRoutes } from "./routes/me";
import { revisionRoutes } from "./routes/revisions";
import { staticRoutes } from "./routes/static";
import { tokenRoutes } from "./routes/tokens";
import type { Services } from "./services";
import type { AppEnv } from "./types";

export type AppDeps = {
	db: Db;
	env: Env;
	services: Services;
	fetch?: typeof fetch;
};

export function createApp({ db, env, services, fetch: fetchFn }: AppDeps) {
	return (
		new Hono<AppEnv>()
			.use(async (c, next) => {
				c.set("db", db);
				c.set("env", env);
				c.set("svc", services);
				await next();
			})
			// Registered before auth: blobs are public and need no user lookup.
			.route("/blobs", blobRoutes)
			.use(authMiddleware)
			.route("/auth", authRoutes(fetchFn))
			.route("/api/me", meRoutes)
			.route("/api/tokens", tokenRoutes)
			.route("/api/maps", mapRoutes)
			.route("/api/revisions", revisionRoutes)
			.route(
				"/",
				staticRoutes(env.WEB_DIST ?? `${import.meta.dir}/../../web/dist`),
			)
	);
}

export type AppType = ReturnType<typeof createApp>;

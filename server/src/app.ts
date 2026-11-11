import { Hono, type MiddlewareHandler } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { asyncApiDocument } from "./asyncapi";
import { authMiddleware } from "./auth/session";
import type { Db } from "./db/client";
import { docsRoutes } from "./docs";
import type { Env } from "./env";
import { apiDescription, securitySchemes, tags } from "./openapi";
import { loadAccess } from "./permissions";
import { authRoutes } from "./routes/auth";
import { blobRoutes } from "./routes/blobs";
import { dimensionRoutes } from "./routes/dimensions";
import { featureRoutes } from "./routes/features";
import { inviteRoutes } from "./routes/invites";
import { layerRoutes } from "./routes/layers";
import { mapRoutes } from "./routes/map";
import { meRoutes } from "./routes/me";
import { memberRoutes } from "./routes/members";
import { previewRoutes } from "./routes/preview";
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
	// The spec route is registered before the static catch-all but describes the finished app.
	let self: Hono<AppEnv>;
	let spec: MiddlewareHandler<AppEnv> | undefined;
	const app = new Hono<AppEnv>()
		.use(async (c, next) => {
			c.set("db", db);
			c.set("env", env);
			c.set("svc", services);
			await next();
		})
		// Registered before auth: blobs are public and need no user lookup.
		.route("/blobs", blobRoutes)
		.use(authMiddleware)
		.use("/api/*", async (c, next) => {
			const { map, role } = await loadAccess(db, c.var.user);
			c.set("map", map);
			c.set("role", role);
			await next();
		})
		.route("/auth", authRoutes(fetchFn))
		.route("/api/me", meRoutes)
		.route("/api/tokens", tokenRoutes)
		.route("/api/map", mapRoutes)
		.route("/api/dimensions", dimensionRoutes)
		.route("/api/members", memberRoutes)
		.route("/api/revisions", revisionRoutes)
		.route("/api/layers", layerRoutes)
		.route("/api/invites", inviteRoutes)
		.route("/api/preview.png", previewRoutes)
		.route("/api/features", featureRoutes)
		.get("/api/asyncapi.json", (c) => c.json(asyncApiDocument(env)))
		.route("/scalar", docsRoutes)
		.get("/api/openapi.json", (c, next) => {
			spec ??= openAPIRouteHandler(self, {
				excludeStaticFile: false, // /api/preview.png is an endpoint

				documentation: {
					info: {
						title: "AOMC Map API",
						version: "1.0.0",
						description: apiDescription,
					},
					servers: [{ url: env.PUBLIC_URL }],
					tags,
					components: { securitySchemes },
				},
			});
			return spec(c, next);
		})
		.route(
			"/",
			staticRoutes(env.WEB_DIST ?? `${import.meta.dir}/../../web/dist`),
		);
	self = app;
	return app;
}

export type AppType = ReturnType<typeof createApp>;

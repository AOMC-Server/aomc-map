import { isReadOnly, MAX_JSON_BYTES } from "@aomc/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { openAPIRouteHandler } from "hono-openapi";
import { asyncApiDocument } from "./asyncapi";
import { isRead, roleCap, scopeMiddleware } from "./auth/scopes";
import { authMiddleware } from "./auth/session";
import type { Db } from "./db/client";
import { docsRoutes } from "./docs";
import type { Env } from "./env";
import { apiDescription, securitySchemes, tags } from "./openapi";
import { atLeast, loadAccess } from "./permissions";
import { limitWrites } from "./ratelimit";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { blobRoutes } from "./routes/blobs";
import { dimensionRoutes } from "./routes/dimensions";
import { eventRoutes } from "./routes/events";
import { featureRoutes } from "./routes/features";
import { inviteRoutes } from "./routes/invites";
import { layerRoutes } from "./routes/layers";
import { legacyTileRoutes } from "./routes/legacyTiles";
import { linkRoutes, shortLinkRedirect } from "./routes/links";
import { mapRoutes } from "./routes/map";
import { meRoutes } from "./routes/me";
import { memberRoutes } from "./routes/members";
import { previewRoutes } from "./routes/preview";
import { revisionRoutes } from "./routes/revisions";
import { staticRoutes } from "./routes/static";
import { statsRoutes } from "./routes/stats";
import { tokenRoutes } from "./routes/tokens";
import type { Services } from "./services";
import type { AppEnv } from "./types";

const isUpload = (path: string) =>
	/^\/api\/dimensions\/[^/]+\/uploads\/?$/.test(path);

/** Writes that leave the map alone: your own account and tokens, and short links. */
const worksInMaintenance = (path: string) =>
	/^\/api\/(me|tokens|links)(\/.*)?$/.test(path);

const jsonLimit = bodyLimit({
	maxSize: MAX_JSON_BYTES,
	onError: (c) => c.json({ error: "request body too large" }, 413),
});

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
		.use(services.traffic.middleware)
		.use((c, next) => (isUpload(c.req.path) ? next() : jsonLimit(c, next)))
		// Registered before auth: blobs and tiles are public and need no user lookup.
		.route("/blobs", blobRoutes)
		.route("/map", legacyTileRoutes)
		.use(authMiddleware)
		.use(scopeMiddleware)
		.use("/api/*", async (c, next) => {
			const { map, role } = await loadAccess(db, c.var.user);
			c.set("map", map);
			// A token writes with no more of its user's powers than its scopes allow.
			const cap =
				c.var.scopes && !isRead(c.req.method) ? roleCap(c.var.scopes) : null;
			c.set("role", cap && !atLeast(cap, role) ? cap : role);
			const readOnly = isReadOnly(role, map.maintenance);
			c.set("readOnly", readOnly);
			if (readOnly && !isRead(c.req.method) && !worksInMaintenance(c.req.path))
				return c.json(
					{
						error:
							"The map is in maintenance: it is read only until an owner turns maintenance off.",
						reason: "maintenance",
					},
					503,
				);
			await next();
		})
		.use("/api/layers/*", limitWrites)
		.use("/api/features/*", limitWrites)
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
		.route("/api/stats", statsRoutes)
		.route("/api/links", linkRoutes)
		.route("/s", shortLinkRedirect)
		.route("/api/admin", adminRoutes)
		.route("/api/events", eventRoutes)
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
	app.onError((err, c) => {
		if (err instanceof HTTPException) {
			// A handler may carry its own response; otherwise answer in the API's error format.
			if (err.res) return err.getResponse();
			return c.json({ error: err.message || "request failed" }, err.status);
		}
		console.error(err);
		return c.json({ error: "internal server error" }, 500);
	});
	self = app;
	return app;
}

export type AppType = ReturnType<typeof createApp>;

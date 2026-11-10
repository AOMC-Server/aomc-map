import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { AppEnv } from "../types";

const API_PREFIXES = ["/api/", "/auth/", "/blobs/"];

/** Serves the built web app, with index.html as the fallback for client-side routes. */
export function staticRoutes(distDir: string) {
	const app = new Hono<AppEnv>();
	app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
	if (!existsSync(join(distDir, "index.html"))) return app;

	// serveStatic resolves its root against the working directory.
	const root = relative(process.cwd(), distDir) || ".";
	return app
		.use(
			"*",
			serveStatic({
				root,
				onFound: (path, c) => {
					if (path.includes("/assets/")) {
						c.header("Cache-Control", "public, max-age=31536000, immutable");
					}
				},
			}),
		)
		.get("*", async (c, next) => {
			if (API_PREFIXES.some((p) => c.req.path.startsWith(p))) {
				return c.json({ error: "not found" }, 404);
			}
			const res = await serveStatic({ root, path: "index.html" })(c, next);
			return res ?? c.res;
		});
}

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { type Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { injectMeta, type PageMeta } from "../html";
import { loadMap } from "../permissions";
import { resolvePreviewTarget, viewQuerySchema } from "../previewTarget";
import type { AppEnv } from "../types";

const notFound = (c: Context<AppEnv>) => c.json({ error: "not found" }, 404);

/** Serves the built web app, with index.html as the fallback for client-side routes. */
export function staticRoutes(distDir: string) {
	const app = new Hono<AppEnv>();
	for (const prefix of ["/api", "/auth", "/blobs"])
		app.all(`${prefix}/*`, notFound);
	const indexPath = join(distDir, "index.html");
	if (!existsSync(indexPath)) return app;

	/** Share tags for the page at "/", from the view in the query string. */
	async function metaFor(c: Context<AppEnv>): Promise<PageMeta | null> {
		const { db, env } = c.var;
		const query = viewQuerySchema.safeParse(
			Object.fromEntries(new URL(c.req.url).searchParams),
		);
		if (!query.success) return null;
		const target = await resolvePreviewTarget(
			db,
			env,
			await loadMap(db),
			query.data,
		);
		if (!target) return null;

		const { x, z, zoom, rev } = target.params;
		const view = new URLSearchParams({
			dim: target.dimensionSlug,
			x: String(x),
			z: String(z),
			zoom: String(zoom),
		});
		if (query.data.rev !== undefined) view.set("rev", String(rev));
		const withBase = (path: string) => {
			const url = new URL(path, env.PUBLIC_URL);
			url.search = view.toString();
			return url.toString();
		};
		return {
			title: `${target.mapName}: ${target.dimensionName}`,
			description: `${target.mapName}, ${target.dimensionName}, around x ${x}, z ${z}${query.data.rev !== undefined ? ` (revision ${rev})` : ""}`,
			url: withBase("/"),
			image: withBase("/api/preview.png"),
		};
	}

	// serveStatic resolves its root against the working directory.
	const root = relative(process.cwd(), distDir) || ".";
	return app
		.get("/", async (c) => {
			const html = await Bun.file(indexPath).text();
			const meta = await metaFor(c);
			c.header("Cache-Control", "no-cache");
			return c.html(meta ? injectMeta(html, meta) : html);
		})
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
			const res = await serveStatic({
				root,
				path: "index.html",
				onFound: (_path, c) => {
					c.header("Cache-Control", "no-cache");
				},
			})(c, next);
			return res ?? c.res;
		});
}

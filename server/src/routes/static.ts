import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { injectMeta, type PageMeta } from "../html";
import { resolvePreviewTarget, viewQuerySchema } from "../previewTarget";
import type { AppEnv } from "../types";

const API_PREFIXES = ["/api/", "/auth/", "/blobs/"];

/** Serves the built web app, with index.html as the fallback for client-side routes. */
export function staticRoutes(distDir: string) {
	const app = new Hono<AppEnv>();
	app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
	const indexPath = join(distDir, "index.html");
	if (!existsSync(indexPath)) return app;

	/**
	 * Share tags for the page at "/". Crawlers are anonymous, so only public maps get a title and
	 * preview image; anything else keeps the generic page and leaks nothing.
	 */
	async function metaFor(
		c: import("hono").Context<AppEnv>,
	): Promise<PageMeta | null> {
		const { db, env } = c.var;
		const query = viewQuerySchema.safeParse(
			Object.fromEntries(new URL(c.req.url).searchParams),
		);
		if (!query.success) return null;
		const target = await resolvePreviewTarget(db, env, null, query.data);
		if (!target) return null;

		const { x, z, zoom, rev } = target.params;
		const view = new URLSearchParams({
			map: target.mapSlug,
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
			if (API_PREFIXES.some((p) => c.req.path.startsWith(p))) {
				return c.json({ error: "not found" }, 404);
			}
			const res = await serveStatic({ root, path: "index.html" })(c, next);
			return res ?? c.res;
		});
}

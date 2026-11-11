import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { resolvePreviewTarget, viewQuerySchema } from "../previewTarget";
import type { AppEnv } from "../types";

/** GET /api/preview.png?dim&x&z&zoom&rev: a 1200x630 picture of the map around a point. */
export const previewRoutes = new Hono<AppEnv>().get(
	"/",
	zValidator("query", viewQuerySchema),
	async (c) => {
		const { db, env, svc, map } = c.var;
		const q = c.req.valid("query");
		const target = await resolvePreviewTarget(db, env, map, q);
		if (!target) return c.json({ error: "not found" }, 404);

		const png = await svc.preview.get(db, svc.blobs, target.params);
		// A pinned revision never changes; "latest" may.
		c.header(
			"Cache-Control",
			`public, max-age=${q.rev === undefined ? 300 : 86400}`,
		);
		c.header("Content-Type", "image/png");
		return c.body(png as unknown as ArrayBuffer);
	},
);

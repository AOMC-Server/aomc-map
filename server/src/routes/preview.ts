import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { resolvePreviewTarget, viewQuerySchema } from "../previewTarget";
import type { AppEnv } from "../types";

/** GET /api/preview.png?map&dim&x&z&zoom&rev: a 1200x630 picture of the map around a point. */
export const previewRoutes = new Hono<AppEnv>().get(
	"/",
	zValidator("query", viewQuerySchema),
	async (c) => {
		const { db, env, svc } = c.var;
		const q = c.req.valid("query");
		const target = await resolvePreviewTarget(db, env, c.var.user, q);
		if (!target) return c.json({ error: "not found" }, 404);

		const png = await svc.preview.get(
			db,
			svc.blobs,
			target.mapId,
			target.params,
		);
		const scope = target.isPublic ? "public" : "private";
		// A pinned revision never changes; "latest" may.
		c.header(
			"Cache-Control",
			`${scope}, max-age=${q.rev === undefined ? 300 : 86400}`,
		);
		c.header("Content-Type", "image/png");
		return c.body(png as unknown as ArrayBuffer);
	},
);

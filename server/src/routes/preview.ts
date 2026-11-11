import { Hono } from "hono";
import { doc } from "../openapi";
import { PreviewBusyError, PreviewLimitError } from "../preview";
import { resolvePreviewTarget, viewQuerySchema } from "../previewTarget";
import { clientKey } from "../ratelimit";
import type { AppEnv } from "../types";
import { validate } from "../validate";

/** GET /api/preview.png?dim&x&z&zoom&rev: a 1200x630 picture of the map around a point. */
export const previewRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Images",
		summary: "Render a link-preview image",
		description:
			"A 1200×630 PNG of the tiles around a point with a marker in the middle. Tiles only, no layers. The position and zoom are rounded (zoom to half levels), so nearby views share one picture. Renders are rate limited per client and queued; a full queue answers 503.",
		ok: { 200: "PNG image" },
		fails: [400, 404, 429, 503],
	}),
	validate("query", viewQuerySchema),
	async (c) => {
		const { db, env, svc, map } = c.var;
		const q = c.req.valid("query");
		const target = await resolvePreviewTarget(db, env, map, q);
		if (!target) return c.json({ error: "not found" }, 404);

		const client = clientKey(c);
		let png: Buffer;
		try {
			png = await svc.preview.get(db, svc.blobs, target.params, () =>
				svc.previewLimiter.hit(client),
			);
		} catch (err) {
			if (err instanceof PreviewLimitError)
				return c.json({ error: "too many previews, slow down" }, 429);
			if (err instanceof PreviewBusyError) {
				c.header("Retry-After", "5");
				return c.json({ error: "busy, try again shortly" }, 503);
			}
			throw err;
		}
		// A revision that exists never changes; "latest" and revisions still to come may.
		const pinned = q.rev !== undefined && q.rev <= map.headRev;
		c.header("Cache-Control", `public, max-age=${pinned ? 86400 : 300}`);
		c.header("Content-Type", "image/png");
		return c.body(png as unknown as ArrayBuffer);
	},
);

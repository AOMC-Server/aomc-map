import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { dimensions, revisions } from "../db/schema";
import { doc } from "../openapi";
import { tileVersionAt } from "../tiles/history";
import { isolatedTile, patchHash } from "../tiles/isolated";
import type { AppEnv } from "../types";

const IMMUTABLE = "public, max-age=31536000, immutable";

export const tileRoutes = new Hono<AppEnv>().get(
	"/:zoom/:x/:y",
	doc({
		tag: "Tiles",
		summary: "Get a map tile",
		description:
			"Zoom 0 is 1:1 and a tile index is `floor(block / tileSize)`. Answers a redirect to the immutable blob, or 204 when the tile is empty. With `only`, the tile of that single upload.",
		ok: {
			200: "WebP tile (only with `only` above zoom 0)",
			204: "No data here",
			302: "Redirect to /blobs/<hash>.webp",
		},
		fails: [400, 404],
		query: {
			rev: "Show the map as of this revision (default: latest)",
			only: "Upload revision id: show only what that upload added",
		},
	}),
	async (c) => {
		const { db, env, map } = c.var;

		const zoom = Number(c.req.param("zoom"));
		const x = Number(c.req.param("x"));
		const y = Number(c.req.param("y"));
		if (!Number.isInteger(zoom) || zoom < 0 || zoom > env.MAX_ZOOM) {
			return c.json({ error: "zoom out of range" }, 400);
		}
		if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
			return c.json({ error: "bad tile coordinates" }, 400);
		}

		const onlyParam = c.req.query("only");
		if (onlyParam !== undefined && !/^\d+$/.test(onlyParam)) {
			return c.json({ error: "bad only" }, 400);
		}

		const revParam = c.req.query("rev");
		if (revParam !== undefined && !/^\d+$/.test(revParam)) {
			return c.json({ error: "bad rev" }, 400);
		}
		const rev = revParam === undefined ? map.headRev : Number(revParam);
		if (rev > map.headRev) return c.json({ error: "unknown rev" }, 400);

		const [dim] = await db
			.select({ id: dimensions.id })
			.from(dimensions)
			.where(eq(dimensions.slug, c.req.param("dim") ?? ""));
		if (!dim) return c.json({ error: "not found" }, 404);

		// One upload on its own, as it was uploaded: no other upload, no later revert or edit.
		if (onlyParam !== undefined) {
			const [revision] = await db
				.select({ dimensionId: revisions.dimensionId, kind: revisions.kind })
				.from(revisions)
				.where(eq(revisions.id, Number(onlyParam)));
			if (revision?.kind !== "upload" || revision.dimensionId !== dim.id) {
				return c.json({ error: "not found" }, 404);
			}
			c.header("Cache-Control", IMMUTABLE);
			if (zoom === 0) {
				const hash = await patchHash(db, Number(onlyParam), x, y);
				return hash
					? c.redirect(`/blobs/${hash}.webp`, 302)
					: c.body(null, 204);
			}
			const webp = await isolatedTile(
				db,
				c.var.svc.blobs,
				map.tileSize,
				Number(onlyParam),
				zoom,
				x,
				y,
			);
			return webp
				? c.body(new Uint8Array(webp), 200, { "Content-Type": "image/webp" })
				: c.body(null, 204);
		}

		c.header(
			"Cache-Control",
			revParam === undefined ? "public, max-age=10" : IMMUTABLE,
		);

		const version = await tileVersionAt(db, dim.id, zoom, x, y, rev);
		if (!version?.blobHash) return c.body(null, 204);
		return c.redirect(`/blobs/${version.blobHash}.webp`, 302);
	},
);

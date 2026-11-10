import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { dimensions } from "../db/schema";
import { loadMapAccess } from "../permissions";
import { tileVersionAt } from "../tiles/history";
import type { AppEnv } from "../types";

const IMMUTABLE = "public, max-age=31536000, immutable";

export const tileRoutes = new Hono<AppEnv>().get("/:zoom/:x/:y", async (c) => {
	const { db, env } = c.var;
	const access = await loadMapAccess(db, c.var.user, c.req.param("slug") ?? "");
	if (!access) return c.json({ error: "not found" }, 404);

	const zoom = Number(c.req.param("zoom"));
	const x = Number(c.req.param("x"));
	const y = Number(c.req.param("y"));
	if (!Number.isInteger(zoom) || zoom < 0 || zoom > env.MAX_ZOOM) {
		return c.json({ error: "zoom out of range" }, 400);
	}
	if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
		return c.json({ error: "bad tile coordinates" }, 400);
	}

	const revParam = c.req.query("rev");
	if (revParam !== undefined && !/^\d+$/.test(revParam)) {
		return c.json({ error: "bad rev" }, 400);
	}
	const rev = revParam === undefined ? access.map.headRev : Number(revParam);
	if (rev > access.map.headRev) return c.json({ error: "unknown rev" }, 400);

	const [dim] = await db
		.select({ id: dimensions.id })
		.from(dimensions)
		.where(
			and(
				eq(dimensions.mapId, access.map.id),
				eq(dimensions.slug, c.req.param("dim") ?? ""),
			),
		);
	if (!dim) return c.json({ error: "not found" }, 404);

	// Shared caches must not hold tiles of private maps.
	const scope = access.map.visibility === "private" ? "private" : "public";
	c.header(
		"Cache-Control",
		revParam === undefined
			? `${scope}, max-age=10`
			: scope === "private"
				? "private, max-age=31536000, immutable"
				: IMMUTABLE,
	);

	const version = await tileVersionAt(db, dim.id, zoom, x, y, rev);
	if (!version?.blobHash) return c.body(null, 204);
	return c.redirect(`/blobs/${version.blobHash}.webp`, 302);
});

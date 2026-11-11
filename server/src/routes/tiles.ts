import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { IMMUTABLE } from "../cache";
import { revisions } from "../db/schema";
import { dimensionBySlug } from "../dimensionLookup";
import { doc } from "../openapi";
import {
	isTileFormat,
	TILE_FORMATS,
	type TileFormat,
	transcode,
} from "../tiles/formats";
import { tileHashesIn, tileVersionAt } from "../tiles/history";
import { isolatedTile, patchHash } from "../tiles/isolated";
import type { AppEnv } from "../types";
import { validate } from "../validate";

/** Most tiles one hash lookup may cover. */
export const MAX_HASH_AREA = 4096;

/**
 * A pinned revision is only immutable under the current map epoch (`v`): an erase rewrites
 * history from its revision on, and revision numbers can be reused afterwards.
 */
const pinnedCache = (vParam: string | undefined, epoch: number) =>
	vParam === String(epoch) ? IMMUTABLE : "public, max-age=60";

/** Read as strings: the handler answers each malformed value with its own message. */
const hashesQuerySchema = z.object({
	minX: z.string().optional().describe("Leftmost tile index"),
	minY: z.string().optional().describe("Topmost tile index"),
	maxX: z.string().optional().describe("Rightmost tile index"),
	maxY: z.string().optional().describe("Bottommost tile index"),
	rev: z
		.string()
		.optional()
		.describe("Show the map as of this revision (default: latest)"),
	v: z
		.string()
		.optional()
		.describe(
			"The map epoch (`epoch` of `GET /api/map`); makes `rev` cacheable for good",
		),
});

export const tileRoutes = new Hono<AppEnv>()
	.get(
		"/:zoom/:x/:y",
		doc({
			tag: "Tiles",
			summary: "Get a map tile",
			description: [
				"Zoom 0 is the most detailed level (one pixel per block); each level above halves the detail. A tile index is `floor(block / tileSize)` at zoom 0.",
				"",
				"Answers a redirect to the tile image, which never changes, or 204 when there is nothing here. With `only`, the tile of that one upload instead.",
				"",
				"**Formats.** Tiles are stored as lossless WebP. Pick another format with `format`:",
				"",
				"| `format` | Image |",
				"| --- | --- |",
				"| `webp` (default) | Lossless WebP, as stored |",
				"| `png` | Lossless PNG |",
				"| `jpg-95` | JPEG, quality 95 |",
				"| `jpg-80` | JPEG, quality 80 |",
				"| `webp-lossy` | Lossy WebP, quality 80 |",
				"",
				"JPEG has no transparency: unexplored areas are black.",
			].join("\n"),
			ok: {
				200: "The tile image (only with `only` above zoom 0, where the tile is made on the fly)",
				204: "Nothing mapped here",
				302: "Redirect to `/blobs/<hash>.<suffix>` (see *Get a tile image by hash*)",
			},
			fails: [400, 404],
			query: {
				rev: "Show the map as of this revision (default: latest)",
				v: "The map epoch (`epoch` of `GET /api/map`). `rev` and `only` responses are cached for good only when it matches",
				only: "Upload revision id: show only what that upload added (finished uploads only)",
				format:
					"`webp` (default), `png`, `jpg-95`, `jpg-80` or `webp-lossy`; see the table above",
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

			const formatParam = c.req.query("format");
			if (formatParam !== undefined && !isTileFormat(formatParam)) {
				return c.json({ error: "bad format" }, 400);
			}
			const format: TileFormat = formatParam ?? "webp";
			const suffix = TILE_FORMATS[format].suffix;

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

			const dim = dimensionBySlug(db, c.req.param("dim") ?? "");
			if (!dim) return c.json({ error: "not found" }, 404);

			// One upload on its own, as it was uploaded: no other upload, no later revert or edit.
			if (onlyParam !== undefined) {
				const [revision] = await db
					.select({
						dimensionId: revisions.dimensionId,
						kind: revisions.kind,
						status: revisions.status,
					})
					.from(revisions)
					.where(eq(revisions.id, Number(onlyParam)));
				// Until it is done it has no patches yet, and an empty answer must not stick.
				if (
					revision?.kind !== "upload" ||
					revision.dimensionId !== dim.id ||
					revision.status !== "done"
				) {
					c.header("Cache-Control", "no-store");
					return c.json({ error: "not found" }, 404);
				}
				c.header("Cache-Control", pinnedCache(c.req.query("v"), map.epoch));
				if (zoom === 0) {
					const hash = await patchHash(db, Number(onlyParam), x, y);
					return hash
						? c.redirect(`/blobs/${hash}.${suffix}`, 302)
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
				if (!webp) return c.body(null, 204);
				const image = format === "webp" ? webp : await transcode(webp, format);
				return c.body(new Uint8Array(image), 200, {
					"Content-Type": TILE_FORMATS[format].type,
				});
			}

			c.header(
				"Cache-Control",
				revParam === undefined
					? "public, max-age=10"
					: pinnedCache(c.req.query("v"), map.epoch),
			);

			const version = await tileVersionAt(db, dim.id, zoom, x, y, rev);
			if (!version?.blobHash) return c.body(null, 204);
			return c.redirect(`/blobs/${version.blobHash}.${suffix}`, 302);
		},
	)
	.get(
		"/:zoom/hashes",
		doc({
			tag: "Tiles",
			summary: "Get the tile hashes of an area",
			description: [
				`The hashes of every tile from \`minX\`,\`minY\` to \`maxX\`,\`maxY\` (inclusive, at most ${MAX_HASH_AREA} tiles), in one request. Tiles not listed are empty.`,
				"",
				"Load each image straight from `/blobs/<hash>.<suffix>` (see *Get a tile image by hash*). This saves the redirect of *Get a map tile* for every tile, and tiles that did not change between revisions keep their hash, so they need no new download.",
			].join("\n"),
			ok: { 200: "`{ tiles: [{ x, y, hash }] }`" },
			fails: [400, 404],
		}),
		validate("query", hashesQuerySchema),
		async (c) => {
			const { db, env, map } = c.var;
			const q = c.req.valid("query");

			const zoom = Number(c.req.param("zoom"));
			if (!Number.isInteger(zoom) || zoom < 0 || zoom > env.MAX_ZOOM) {
				return c.json({ error: "zoom out of range" }, 400);
			}
			const [minX, minY, maxX, maxY] = [q.minX, q.minY, q.maxX, q.maxY].map(
				(value) => Number(value ?? Number.NaN),
			) as [number, number, number, number];
			if (
				![minX, minY, maxX, maxY].every(Number.isSafeInteger) ||
				maxX < minX ||
				maxY < minY
			) {
				return c.json({ error: "bad tile coordinates" }, 400);
			}
			if ((maxX - minX + 1) * (maxY - minY + 1) > MAX_HASH_AREA) {
				return c.json({ error: "area too large" }, 400);
			}

			const revParam = q.rev;
			if (revParam !== undefined && !/^\d+$/.test(revParam)) {
				return c.json({ error: "bad rev" }, 400);
			}
			const rev = revParam === undefined ? map.headRev : Number(revParam);
			if (rev > map.headRev) return c.json({ error: "unknown rev" }, 400);

			const dim = dimensionBySlug(db, c.req.param("dim") ?? "");
			if (!dim) return c.json({ error: "not found" }, 404);

			c.header(
				"Cache-Control",
				revParam === undefined
					? "public, max-age=10"
					: pinnedCache(q.v, map.epoch),
			);
			const tiles = await tileHashesIn(
				db,
				dim.id,
				zoom,
				{ minX, minY, maxX, maxY },
				rev,
			);
			return c.json({ tiles });
		},
	);

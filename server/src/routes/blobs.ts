import { Hono } from "hono";
import { doc } from "../openapi";
import { isBlobHash } from "../tiles/blobstore";
import { formatOfSuffix, TILE_FORMATS } from "../tiles/formats";
import type { AppEnv } from "../types";

/** For anything that can never change under its URL. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** Unauthenticated: hashes are unguessable, but a shared hash of a private map's tile is readable. */
export const blobRoutes = new Hono<AppEnv>().get(
	"/:file",
	doc({
		tag: "Images",
		summary: "Get a tile image by hash",
		description: [
			"`<file>` is the tile's hash followed by a suffix for the format. The tile endpoints redirect here, so there is usually no need to build these URLs yourself.",
			"",
			"| Suffix | Image |",
			"| --- | --- |",
			"| `.webp` | Lossless WebP, as stored |",
			"| `.png` | Lossless PNG |",
			"| `.95.jpg` | JPEG, quality 95 (transparency becomes black) |",
			"| `.80.jpg` | JPEG, quality 80 (transparency becomes black) |",
			"| `.lossy.webp` | Lossy WebP, quality 80 |",
			"",
			"Images never change and may be cached for good. Formats other than `.webp` are converted on first request and then kept.",
		].join("\n"),
		ok: { 200: "The image" },
		fails: [404],
	}),
	async (c) => {
		const file = c.req.param("file");
		const hash = file.slice(0, 64);
		const format = formatOfSuffix(file.slice(65));
		if (!isBlobHash(hash) || file[64] !== "." || !format) {
			return c.json({ error: "not found" }, 404);
		}
		const blobs = c.var.svc.blobs;
		if (!(await blobs.file(hash).exists())) {
			return c.json({ error: "not found" }, 404);
		}
		const blob =
			format === "webp" ? blobs.file(hash) : await blobs.derived(hash, format);
		return new Response(blob, {
			headers: {
				"Content-Type": TILE_FORMATS[format].type,
				"Content-Length": String(blob.size),
				"Cache-Control": IMMUTABLE,
			},
		});
	},
);

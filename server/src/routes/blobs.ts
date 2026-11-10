import { Hono } from "hono";
import { isBlobHash } from "../tiles/blobstore";
import type { AppEnv } from "../types";

/** Unauthenticated: hashes are unguessable, but a shared hash of a private map's tile is readable. */
export const blobRoutes = new Hono<AppEnv>().get("/:file", async (c) => {
	const file = c.req.param("file");
	const hash = file.endsWith(".webp") ? file.slice(0, -5) : "";
	if (!isBlobHash(hash)) return c.json({ error: "not found" }, 404);
	const blob = c.var.svc.blobs.file(hash);
	if (!(await blob.exists())) return c.json({ error: "not found" }, 404);
	return new Response(blob, {
		headers: {
			"Content-Type": "image/webp",
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
});

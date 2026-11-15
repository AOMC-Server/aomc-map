import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { fileEntries } from "../db/schema";
import { resolveEntry } from "../files/library";
import type { AppEnv } from "../types";

/** The names in a /files/… path, decoded; null when the path is not valid. */
export function namesOfPath(pathname: string): string[] | null {
	try {
		return pathname
			.replace(/^\/files\/?/, "")
			.split("/")
			.filter((s) => s !== "")
			.map((s) => decodeURIComponent(s).normalize("NFC"));
	} catch {
		return null;
	}
}

/** `filename*` carries the real name; `filename` is a plain fallback for old clients. */
export function contentDisposition(name: string): string {
	const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The one byte range asked for, as [start, end] inclusive; "invalid" when it can't be served. */
export function parseRange(
	header: string | undefined,
	size: number,
): [number, number] | "invalid" | null {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null; // several ranges or another unit: send the whole file
	const [, a = "", b = ""] = m;
	if (a === "" && b === "") return "invalid";
	if (a === "") {
		const n = Number(b);
		if (n === 0 || size === 0) return "invalid";
		return [Math.max(0, size - n), size - 1];
	}
	const start = Number(a);
	const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
	if (start >= size || end < start) return "invalid";
	return [start, end];
}

/**
 * /files/<folders>/<name>: downloads a file of the library, for logged-in users only; anyone
 * else is sent to the Discord login and comes back here. Paths that are not a file (folders,
 * the library itself) fall through to the web app, which shows them.
 */
export const fileDownloadRoutes = new Hono<AppEnv>().get(
	"/*",
	async (c, next) => {
		const { db, svc } = c.var;
		const names = namesOfPath(new URL(c.req.url).pathname);
		if (!names) return c.json({ error: "not found" }, 404);
		const found = resolveEntry(db, names);
		if (!found) return next();

		if (!c.var.user) {
			if (c.req.header("Authorization"))
				return c.json({ error: 'this token lacks the "read" scope' }, 403);
			const back = new URL(c.req.url);
			return c.redirect(
				`/auth/discord?returnTo=${encodeURIComponent(back.pathname + back.search)}`,
			);
		}

		const { entry } = found;
		const file = svc.files.file(entry.hash);
		if (!(await file.exists())) return c.json({ error: "not found" }, 404);
		const etag = `"${entry.hash}"`;
		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": contentDisposition(entry.name),
			"Cache-Control": "private, no-cache",
			"Accept-Ranges": "bytes",
			ETag: etag,
			"Last-Modified": new Date(entry.updatedAt).toUTCString(),
		};
		if (c.req.header("If-None-Match") === etag)
			return new Response(null, { status: 304, headers });

		const ifRange = c.req.header("If-Range");
		const range =
			ifRange && ifRange !== etag
				? null
				: parseRange(c.req.header("Range"), entry.bytes);
		if (range === "invalid")
			return new Response(null, {
				status: 416,
				headers: { ...headers, "Content-Range": `bytes */${entry.bytes}` },
			});

		// Count a download once, when its first byte is asked for.
		if (c.req.method === "GET" && (range === null || range[0] === 0))
			db.update(fileEntries)
				.set({ downloads: sql`${fileEntries.downloads} + 1` })
				.where(eq(fileEntries.id, entry.id))
				.run();

		if (range === null)
			return new Response(file, {
				headers: { ...headers, "Content-Length": String(entry.bytes) },
			});
		const [start, end] = range;
		return new Response(file.slice(start, end + 1), {
			status: 206,
			headers: {
				...headers,
				"Content-Length": String(end - start + 1),
				"Content-Range": `bytes ${start}-${end}/${entry.bytes}`,
			},
		});
	},
);

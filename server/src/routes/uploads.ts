import { basename } from "node:path";
import { uploadCoordsSchema } from "@aomc/shared";
import { and, eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import sharp from "sharp";
import { requireUser } from "../auth/session";
import { dimensions, jobs, revisions } from "../db/schema";
import { incomingDir, type UploadFile } from "../jobs/types";
import { canUpload, loadMapAccess } from "../permissions";
import { failRevision } from "../tiles/history";
import { parseXaeroCoords } from "../tiles/xaero";
import type { AppEnv } from "../types";

type Entry = { name: string; data: Uint8Array };
type FileError = { file: string; error: string };

export const uploadRoutes = new Hono<AppEnv>().post(
	"/",
	requireUser,
	async (c) => {
		const { db, env, svc } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const access = await loadMapAccess(db, user, c.req.param("slug") ?? "");
		if (!access) return c.json({ error: "not found" }, 404);
		if (!canUpload(access.role)) return c.json({ error: "forbidden" }, 403);

		const [dim] = await db
			.select()
			.from(dimensions)
			.where(
				and(
					eq(dimensions.mapId, access.map.id),
					eq(dimensions.slug, c.req.param("dim") ?? ""),
				),
			);
		if (!dim) return c.json({ error: "not found" }, 404);
		if (dim.archived) return c.json({ error: "dimension is archived" }, 400);

		if (!svc.limiter.hit(user.id))
			return c.json({ error: "too many uploads, slow down" }, 429);
		if (Number(c.req.header("content-length") ?? 0) > env.MAX_UPLOAD_BYTES) {
			return c.json({ error: "upload too large" }, 413);
		}

		let form: FormData;
		try {
			form = await c.req.formData();
		} catch {
			return c.json({ error: "expected multipart/form-data" }, 400);
		}
		const uploaded = [
			...form.getAll("files[]"),
			...form.getAll("files"),
		].filter((v): v is File => typeof v !== "string");
		if (uploaded.length === 0) return c.json({ error: "no files" }, 400);
		if (uploaded.reduce((n, f) => n + f.size, 0) > env.MAX_UPLOAD_BYTES) {
			return c.json({ error: "upload too large" }, 413);
		}

		const errors: FileError[] = [];
		const entries: Entry[] = [];
		for (const file of uploaded) {
			const lower = file.name.toLowerCase();
			if (lower.endsWith(".png")) {
				entries.push({
					name: basename(file.name),
					data: new Uint8Array(await file.arrayBuffer()),
				});
			} else if (lower.endsWith(".zip")) {
				try {
					entries.push(
						...readZip(
							new Uint8Array(await file.arrayBuffer()),
							env.MAX_UPLOAD_BYTES * 2,
						),
					);
				} catch (err) {
					errors.push({
						file: file.name,
						error: err instanceof Error ? err.message : "bad zip",
					});
				}
			} else {
				errors.push({
					file: file.name,
					error: "only .png and .zip files are accepted",
				});
			}
		}
		if (errors.length === 0 && entries.length === 0) {
			return c.json({ error: "no png files found" }, 400);
		}
		if (entries.length > env.MAX_FILES_PER_UPLOAD) {
			return c.json(
				{ error: `too many files (max ${env.MAX_FILES_PER_UPLOAD})` },
				400,
			);
		}

		let explicit: { x: number; z: number }[] | null = null;
		const coordsField = form.get("coords");
		if (typeof coordsField === "string") {
			try {
				explicit = uploadCoordsSchema.parse(JSON.parse(coordsField));
			} catch {
				return c.json(
					{ error: "coords must be a JSON array of {x, z} integers" },
					400,
				);
			}
			if (errors.length === 0 && explicit.length !== entries.length) {
				return c.json(
					{
						error: `coords has ${explicit.length} items but there are ${entries.length} files`,
					},
					400,
				);
			}
		}

		const files: UploadFile[] = [];
		for (const [i, entry] of entries.entries()) {
			const at = explicit ? explicit[i] : parseXaeroCoords(entry.name);
			if (!at) {
				errors.push({
					file: entry.name,
					error: "no coordinates (expected _x<X>_z<Z> in the file name)",
				});
				continue;
			}
			try {
				const meta = await sharp(entry.data).metadata();
				if (meta.format !== "png") throw new Error("not a PNG image");
				const { width = 0, height = 0 } = meta;
				if (
					width < 1 ||
					height < 1 ||
					width > env.MAX_IMAGE_DIM ||
					height > env.MAX_IMAGE_DIM
				) {
					throw new Error(
						`image must be at most ${env.MAX_IMAGE_DIM}x${env.MAX_IMAGE_DIM}`,
					);
				}
				files.push({ x: at.x, z: at.z, width, height });
			} catch (err) {
				errors.push({
					file: entry.name,
					error: err instanceof Error ? err.message : "invalid image",
				});
			}
		}
		if (errors.length > 0)
			return c.json({ error: "invalid files", errors }, 400);

		const [revision] = await db
			.insert(revisions)
			.values({
				mapId: access.map.id,
				kind: "upload",
				dimensionId: dim.id,
				authorId: user.id,
				fileCount: files.length,
			})
			.returning({ id: revisions.id });
		const revisionId = (revision as { id: number }).id;

		// The job is inserted last so the worker can never see it before its files exist.
		try {
			const dir = incomingDir(env, revisionId);
			await Promise.all(
				entries.map((e, i) => Bun.write(`${dir}/${i}.png`, e.data)),
			);
			await db
				.insert(jobs)
				.values({ type: "process_upload", payload: { revisionId, files } });
		} catch (err) {
			console.error(err);
			await failRevision(db, revisionId, "could not store upload");
			return c.json({ error: "could not store upload" }, 500);
		}
		svc.worker.kick();
		return c.json({ revisionId }, 202);
	},
);

/** Expands PNGs from a zip. Directory paths inside the archive are ignored. */
function readZip(data: Uint8Array, maxExpanded: number): Entry[] {
	let total = 0;
	const out: Entry[] = [];
	const unzipped = unzipSync(data, {
		filter(file) {
			const name = basename(file.name);
			if (
				file.name.endsWith("/") ||
				file.name.startsWith("__MACOSX/") ||
				name.startsWith(".")
			) {
				return false;
			}
			if (!name.toLowerCase().endsWith(".png")) return false;
			total += file.originalSize;
			if (total > maxExpanded) throw new Error("zip expands to too much data");
			return true;
		},
	});
	for (const [path, bytes] of Object.entries(unzipped)) {
		out.push({ name: basename(path), data: bytes });
	}
	return out;
}

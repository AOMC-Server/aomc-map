import { basename } from "node:path";
import {
	parseXaeroCoords,
	parseXaeroExportDate,
	uploadCoordsSchema,
	uploadPathsSchema,
} from "@aomc/shared";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import sharp from "sharp";
import { requireUser, userOf } from "../auth/session";
import { dimensions, jobs, revisions } from "../db/schema";
import { incomingDir, type UploadFile } from "../jobs/types";
import { doc } from "../openapi";
import { canEdit } from "../permissions";
import { failRevision } from "../tiles/history";
import type { AppEnv } from "../types";

/** `path` is where the file came from (folders included); it carries the export date. */
type Entry = { name: string; path: string; data: Uint8Array };
type FileError = { file: string; error: string };

export const uploadRoutes = new Hono<AppEnv>().post(
	"/",
	doc({
		tag: "Uploads",
		summary: "Upload Xaero exports",
		description:
			"Send PNG files or ZIPs as multipart/form-data. Coordinates come from `_x<X>_z<Z>` in file names unless `coords` is given. Processing runs in the background: poll `GET /api/revisions/{id}` or stream its events. An upload with several export dates creates one revision per date.",
		ok: {
			202: "Accepted. `revisionId` is the last revision, `revisionIds` all of them, oldest first",
		},
		fails: [400, 403, 404, 413, 429],
		login: true,
		requestBody: {
			required: true,
			content: {
				"multipart/form-data": {
					schema: {
						type: "object",
						required: ["files[]"],
						properties: {
							"files[]": {
								type: "array",
								items: { type: "string", format: "binary" },
								description: "PNG images or ZIPs of them",
							},
							coords: {
								type: "string",
								description:
									"JSON array of {x, z}, aligned with the files (after ZIP expansion); overrides the file names",
							},
							paths: {
								type: "string",
								description:
									"JSON array of strings, aligned with the uploaded files (before ZIP expansion), naming where each came from; carries the export date",
							},
						},
					},
				},
			},
		},
	}),
	requireUser,
	async (c) => {
		const { db, env, svc } = c.var;
		const user = userOf(c);
		if (!canEdit(c.var.role)) return c.json({ error: "forbidden" }, 403);

		const [dim] = await db
			.select()
			.from(dimensions)
			.where(eq(dimensions.slug, c.req.param("dim") ?? ""));
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

		let paths: string[] | null = null;
		const pathsField = form.get("paths");
		if (typeof pathsField === "string") {
			try {
				paths = uploadPathsSchema.parse(JSON.parse(pathsField));
			} catch {
				return c.json({ error: "paths must be a JSON array of strings" }, 400);
			}
			if (paths.length !== uploaded.length) {
				return c.json(
					{
						error: `paths has ${paths.length} items but ${uploaded.length} files were sent`,
					},
					400,
				);
			}
		}

		const errors: FileError[] = [];
		const entries: Entry[] = [];
		for (const [i, file] of uploaded.entries()) {
			const lower = file.name.toLowerCase();
			const origin = paths?.[i] ?? file.name;
			if (lower.endsWith(".png")) {
				entries.push({
					name: basename(file.name),
					path: origin,
					data: new Uint8Array(await file.arrayBuffer()),
				});
			} else if (lower.endsWith(".zip")) {
				try {
					entries.push(
						...readZip(
							new Uint8Array(await file.arrayBuffer()),
							env.MAX_UPLOAD_BYTES * 2,
							origin,
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

		const now = Date.now();
		const parsed: {
			entry: Entry;
			file: UploadFile;
			exportedAt: number | null;
		}[] = [];
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
				const date = parseXaeroExportDate(entry.path);
				parsed.push({
					entry,
					file: { x: at.x, z: at.z, width, height },
					// An export can't be from the future.
					exportedAt: date === null ? null : Math.min(date, now),
				});
			} catch (err) {
				errors.push({
					file: entry.name,
					error: err instanceof Error ? err.message : "invalid image",
				});
			}
		}
		if (errors.length > 0)
			return c.json({ error: "invalid files", errors }, 400);

		// One revision per export, oldest first: jobs run in id order, so each export is stacked
		// onto the map in the order it was made. Files without a date count as uploaded now.
		const groups = new Map<number | null, typeof parsed>();
		for (const item of parsed) {
			const group = groups.get(item.exportedAt) ?? [];
			group.push(item);
			groups.set(item.exportedAt, group);
		}
		const ordered = [...groups.entries()].sort(
			([a], [b]) =>
				(a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY),
		);

		const revisionIds: number[] = [];
		try {
			for (const [exportedAt, group] of ordered) {
				const [revision] = await db
					.insert(revisions)
					.values({
						kind: "upload",
						dimensionId: dim.id,
						authorId: user.id,
						fileCount: group.length,
						exportedAt,
					})
					.returning({ id: revisions.id });
				revisionIds.push((revision as { id: number }).id);
			}

			// The jobs are inserted last so the worker can never see one before its files exist.
			await Promise.all(
				ordered.flatMap(([, group], g) => {
					const dir = incomingDir(env, revisionIds[g] as number);
					return group.map((item, i) =>
						Bun.write(`${dir}/${i}.png`, item.entry.data),
					);
				}),
			);
			for (const [g, [, group]] of ordered.entries()) {
				await db.insert(jobs).values({
					type: "process_upload",
					payload: {
						revisionId: revisionIds[g] as number,
						files: group.map((item) => item.file),
					},
				});
			}
		} catch (err) {
			console.error(err);
			for (const id of revisionIds) {
				await failRevision(db, id, "could not store upload");
			}
			return c.json({ error: "could not store upload" }, 500);
		}
		svc.worker.kick();
		return c.json(
			{ revisionId: revisionIds.at(-1) as number, revisionIds },
			202,
		);
	},
);

/** Expands PNGs from a zip. `origin` is the zip's own path; entries keep their folder path. */
function readZip(
	data: Uint8Array,
	maxExpanded: number,
	origin: string,
): Entry[] {
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
		out.push({ name: basename(path), path: `${origin}/${path}`, data: bytes });
	}
	return out;
}

import { renameSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import {
	isValidTimeZone,
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
import type { AppEnv } from "../types";
import { isModClient } from "../uploadClient";

/** `path` is where the file came from (folders included); it carries the export date. */
type Entry = { name: string; path: string; data: Uint8Array };
type FileError = { file: string; error: string };

export const uploadRoutes = new Hono<AppEnv>().post(
	"/",
	doc({
		tag: "Uploads",
		summary: "Upload Xaero exports",
		description:
			"Send PNG files or ZIPs as multipart/form-data. Coordinates come from `_x<X>_z<Z>` in file names unless `coords` is given. An upload from the in-game mod is recognised by its `User-Agent` (see `MOD_USER_AGENTS`; by default AOMC Webmapper and AOMC Visited) and counted separately in the statistics. Processing runs in the background: poll `GET /api/revisions/{id}` or stream its events. An upload with several export dates creates one revision per date.",
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
							timeZone: {
								type: "string",
								description:
									'IANA time zone of the computer that made the exports, e.g. "Europe/Berlin". Xaero names exports by local time; without this they are read as UTC',
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

		const timeZoneField = form.get("timeZone");
		const timeZone =
			typeof timeZoneField === "string" && timeZoneField !== ""
				? timeZoneField
				: undefined;
		if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
			return c.json({ error: `unknown time zone: ${timeZone}` }, 400);
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
		// What all ZIPs of this request may still expand to, so many small ZIPs can't add up to a bomb.
		const budget = { bytes: env.MAX_UPLOAD_BYTES * 2 };
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
						...readZip(new Uint8Array(await file.arrayBuffer()), origin, {
							budget,
							maxFiles: env.MAX_FILES_PER_UPLOAD - entries.length,
							maxEntryBytes: maxPngBytes(env.MAX_IMAGE_DIM),
						}),
					);
				} catch (err) {
					if (err instanceof LimitError) {
						return c.json({ error: err.message }, err.status);
					}
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
				const date = parseXaeroExportDate(entry.path, timeZone);
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

		const viaMod = isModClient(c.req.header("User-Agent"), env.MOD_USER_AGENTS);
		// The files are written first, under a staging name, because revision ids don't exist yet.
		// Revisions, jobs and the move to incoming/<id> then happen in one transaction (the move is
		// synchronous, so the worker can't see a job before its files), and either all of it
		// happens or none.
		const staging = `${env.DATA_DIR}/incoming/.staging-${crypto.randomUUID()}`;
		const revisionIds: number[] = [];
		try {
			await Promise.all(
				ordered.flatMap(([, group], g) =>
					group.map((item, i) =>
						Bun.write(`${staging}/${g}/${i}.png`, item.entry.data),
					),
				),
			);
			db.transaction((tx) => {
				for (const [g, [exportedAt, group]] of ordered.entries()) {
					const revision = tx
						.insert(revisions)
						.values({
							kind: "upload",
							dimensionId: dim.id,
							authorId: user.id,
							fileCount: group.length,
							exportedAt,
							viaMod,
						})
						.returning({ id: revisions.id })
						.get();
					revisionIds.push(revision.id);
					const dir = incomingDir(env, revision.id);
					rmSync(dir, { recursive: true, force: true });
					renameSync(`${staging}/${g}`, dir);
					tx.insert(jobs)
						.values({
							type: "process_upload",
							payload: {
								revisionId: revision.id,
								files: group.map((item) => item.file),
							},
						})
						.run();
				}
			});
		} catch (err) {
			console.error(err);
			for (const id of revisionIds) {
				await rm(incomingDir(env, id), { recursive: true, force: true });
			}
			return c.json({ error: "could not store upload" }, 500);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
		svc.worker.kick();
		return c.json(
			{ revisionId: revisionIds.at(-1) as number, revisionIds },
			202,
		);
	},
);

/** A request limit hit while reading a ZIP: the whole request is refused with `status`. */
class LimitError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 413,
	) {
		super(message);
	}
}

/** The most a PNG of `maxDim` x `maxDim` can plausibly take: 4 bytes a pixel, plus headers. */
const maxPngBytes = (maxDim: number) => maxDim * maxDim * 4 + 65_536;

/**
 * Expands PNGs from a zip. `origin` is the zip's own path; entries keep their folder path.
 * fflate allocates every entry's declared size, so the limits are checked in the filter,
 * before anything is inflated.
 */
function readZip(
	data: Uint8Array,
	origin: string,
	limits: {
		/** Bytes that may still be expanded; shared by all ZIPs of the request. */
		budget: { bytes: number };
		maxFiles: number;
		maxEntryBytes: number;
	},
): Entry[] {
	const { budget, maxFiles, maxEntryBytes } = limits;
	let count = 0;
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
			if (++count > maxFiles) {
				throw new LimitError("too many files", 400);
			}
			if (file.originalSize > maxEntryBytes) {
				throw new Error(`${name} is too large to be a valid image`);
			}
			budget.bytes -= file.originalSize;
			if (budget.bytes < 0) {
				throw new LimitError("zip expands to too much data", 413);
			}
			return true;
		},
	});
	for (const [path, bytes] of Object.entries(unzipped)) {
		out.push({ name: basename(path), path: `${origin}/${path}`, data: bytes });
	}
	return out;
}

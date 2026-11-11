import { existsSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { orExit, positiveNumber } from "./args";

/**
 * Imports the zoom 0 tiles of the old (v1) map through the public API only.
 *
 * v1 wrote `<src>/<dimension>/0/<x>_<z>.png`, where x and z are the block coordinates of the
 * tile's top-left corner and black pixels mean "no data" (the same convention as uploads).
 *
 * Every tile is sent with an export date (see `date`), so the server layers the import under
 * newer exports instead of treating the tiles as made now.
 */

export type ImportOptions = {
	url: string;
	token: string;
	/** v1 output directory (contains one folder per dimension). */
	src: string;
	batch?: number;
	maxBatchBytes?: number;
	/**
	 * Export date (ms since the epoch) for every tile. Default: each file's modified time, cut
	 * back to the start of its UTC day so the history gets one revision per day, not per second.
	 */
	date?: number;
	/** JSON file that remembers finished files so an interrupted run can resume. */
	statePath?: string;
	/** Only import these v1 dimension folders. */
	dims?: string[];
	/** v1 folder name -> dimension slug, when they differ. */
	dimMap?: Record<string, string>;
	pollMs?: number;
	/** Wait between retries when the server rate-limits uploads. */
	retryMs?: number;
	fetch?: typeof fetch;
	log?: (message: string) => void;
};

export type ImportResult = {
	uploaded: number;
	skipped: number;
	batches: number;
};

type State = { done: Record<string, string[]> };

const TILE_NAME = /^(-?\d+)_(-?\d+)\.png$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY_MS = 86_400_000;
/** The server only reads export dates from the year 2000 on. */
const EARLIEST = Date.UTC(2000, 0, 1);
/** Room left for the multipart framing, `coords` and `paths` within the server's size limit. */
const LIMIT_HEADROOM = 0.9;

/** `YYYY-MM-DD_HH.MM.SS` in UTC, the way Xaero names exports (the server reads it as UTC). */
export function xaeroStamp(ms: number): string {
	const iso = new Date(Math.max(ms, EARLIEST)).toISOString();
	return `${iso.slice(0, 10)}_${iso.slice(11, 19).replaceAll(":", ".")}`;
}

async function loadState(path: string | undefined): Promise<State> {
	if (!path || !existsSync(path)) return { done: {} };
	return JSON.parse(await readFile(path, "utf8")) as State;
}

async function saveState(path: string | undefined, state: State) {
	if (!path) return;
	await writeFile(`${path}.tmp`, JSON.stringify(state));
	await rename(`${path}.tmp`, path);
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
	const f = opts.fetch ?? fetch;
	const log = opts.log ?? console.log;
	const base = opts.url.replace(/\/+$/, "");
	const auth = { Authorization: `Bearer ${opts.token}` };
	let batchSize = positiveNumber("batch", opts.batch ?? 200, { integer: true });
	let maxBytes = positiveNumber(
		"max-batch-bytes",
		opts.maxBatchBytes ?? 100 * 1024 * 1024,
	);
	const pollMs = opts.pollMs ?? 1500;
	const maxPolls = Math.ceil((30 * 60_000) / pollMs);

	const mapRes = await f(`${base}/api/map`, { headers: auth });
	if (!mapRes.ok)
		throw new Error(`cannot open the map (HTTP ${mapRes.status})`);
	const map = (await mapRes.json()) as {
		role: string;
		dimensions: { slug: string }[];
		limits?: { maxUploadBytes?: number; maxFilesPerUpload?: number };
	};
	if (map.limits?.maxUploadBytes)
		maxBytes = Math.min(
			maxBytes,
			Math.floor(map.limits.maxUploadBytes * LIMIT_HEADROOM),
		);
	if (map.limits?.maxFilesPerUpload)
		batchSize = Math.min(batchSize, map.limits.maxFilesPerUpload);
	const known = new Set(map.dimensions.map((d) => d.slug));

	const folders = (await readdir(opts.src, { withFileTypes: true }))
		.filter((e) => e.isDirectory() && existsSync(join(opts.src, e.name, "0")))
		.map((e) => e.name)
		.filter((name) => !opts.dims || opts.dims.includes(name))
		.sort();
	if (folders.length === 0)
		throw new Error(`no <dimension>/0 folders found in ${opts.src}`);

	// Check every dimension up front so a missing one does not stop the run halfway through.
	const missing = folders
		.map((folder) => opts.dimMap?.[folder] ?? folder)
		.filter((slug) => !known.has(slug));
	if (missing.length > 0) {
		throw new Error(
			`dimension${missing.length > 1 ? "s" : ""} ${missing.map((s) => `"${s}"`).join(", ")} ` +
				"not on the map; add them in Manage > Dimensions first, or skip them with --dims",
		);
	}

	const state = await loadState(opts.statePath);
	const result: ImportResult = { uploaded: 0, skipped: 0, batches: 0 };

	for (const folder of folders) {
		const slug = opts.dimMap?.[folder] ?? folder;
		const dir = join(opts.src, folder, "0");
		const finished = new Set(state.done[folder] ?? []);
		const files = (await readdir(dir))
			.filter((name) => TILE_NAME.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const todo = files.filter((name) => !finished.has(name));
		log(
			`${folder}: ${files.length} tiles, ${files.length - todo.length} already done`,
		);

		// Batches are bounded by file count and by total size (read from disk only when uploading).
		const infos = await Promise.all(todo.map((name) => stat(join(dir, name))));
		const sizes = infos.map((info) => info.size);
		const exportedAt = new Map(
			todo.map((name, i) => {
				const mtime = (infos[i] as { mtimeMs: number }).mtimeMs;
				return [name, opts.date ?? Math.floor(mtime / DAY_MS) * DAY_MS];
			}),
		);
		const batches: string[][] = [];
		let current: string[] = [];
		let size = 0;
		for (const [i, name] of todo.entries()) {
			const bytes = sizes[i] as number;
			if (
				current.length > 0 &&
				(current.length >= batchSize || size + bytes > maxBytes)
			) {
				batches.push(current);
				current = [];
				size = 0;
			}
			current.push(name);
			size += bytes;
		}
		if (current.length > 0) batches.push(current);

		for (const [i, batch] of batches.entries()) {
			const outcome = await uploadBatch(batch);
			result.batches++;
			if (outcome === "empty") result.skipped += batch.length;
			else result.uploaded += batch.length;
			state.done[folder] = [...(state.done[folder] ?? []), ...batch];
			await saveState(opts.statePath, state);
			log(
				`${folder}: batch ${i + 1}/${batches.length} ${outcome} (${batch.length} tiles)`,
			);
		}

		async function uploadBatch(batch: string[]): Promise<"done" | "empty"> {
			const form = new FormData();
			for (const name of batch)
				form.append("files[]", new File([Bun.file(join(dir, name))], name));
			form.append(
				"coords",
				JSON.stringify(
					batch.map((name) => {
						const m = TILE_NAME.exec(name) as RegExpExecArray;
						return { x: Number(m[1]), z: Number(m[2]) };
					}),
				),
			);
			// Where each file "came from"; the server reads the export date off the folder name.
			form.append(
				"paths",
				JSON.stringify(
					batch.map(
						(name) => `${xaeroStamp(exportedAt.get(name) as number)}/${name}`,
					),
				),
			);

			let revisionIds: number[] = [];
			for (let attempt = 0; ; attempt++) {
				const res = await f(
					`${base}/api/dimensions/${encodeURIComponent(slug)}/uploads`,
					{
						method: "POST",
						headers: auth,
						body: form,
					},
				);
				if (res.status === 202) {
					const body = (await res.json()) as {
						revisionId: number;
						revisionIds?: number[];
					};
					revisionIds = body.revisionIds ?? [body.revisionId];
					break;
				}
				if (res.status === 429 && attempt < 20) {
					log("rate limited, waiting");
					await sleep(opts.retryMs ?? 15_000);
					continue;
				}
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
					errors?: { file: string; error: string }[];
				};
				const detail = body.errors
					?.slice(0, 3)
					.map((e) => `${e.file}: ${e.error}`)
					.join("; ");
				throw new Error(
					`upload failed (HTTP ${res.status}): ${body.error ?? "unknown error"}${detail ? ` [${detail}]` : ""}`,
				);
			}

			// One revision per export date; the batch is empty only if all of them are.
			const outcomes: ("done" | "empty")[] = [];
			for (const id of revisionIds) outcomes.push(await waitFor(id));
			return outcomes.every((o) => o === "empty") ? "empty" : "done";
		}

		async function waitFor(revisionId: number): Promise<"done" | "empty"> {
			for (let polls = 0; ; polls++) {
				if (polls >= maxPolls)
					throw new Error(`revision ${revisionId} did not finish in time`);
				await sleep(pollMs);
				const r = await f(`${base}/api/revisions/${revisionId}`, {
					headers: auth,
				});
				if (!r.ok)
					throw new Error(
						`cannot read revision ${revisionId} (HTTP ${r.status})`,
					);
				const { revision } = (await r.json()) as {
					revision: { status: string; error: string | null };
				};
				if (revision.status === "done") return "done";
				if (revision.status === "failed") {
					// A batch of tiles that are entirely black has nothing to import.
					if (revision.error?.includes("no map data")) return "empty";
					throw new Error(
						`processing failed: ${revision.error ?? "unknown error"}`,
					);
				}
			}
		}
	}
	return result;
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			url: { type: "string" },
			token: { type: "string", default: process.env.AOMC_TOKEN },
			src: { type: "string" },
			batch: { type: "string", default: "200" },
			date: { type: "string" },
			state: { type: "string" },
			dims: { type: "string" },
			"dim-map": { type: "string", multiple: true },
		},
	});
	if (!values.url || !values.token || !values.src) {
		console.error(
			"usage: bun scripts/import-v1.ts --url https://map.example.com --token aomc_... --src /path/to/v1/data/output\n" +
				"       [--batch 200] [--date 2026-01-31] [--state import-state.json] [--dims overworld,nether] [--dim-map v1name=slug]\n" +
				"       (--date: export date for every tile, UTC; default is each file's modified time)\n" +
				"       (the token can also come from the AOMC_TOKEN environment variable)",
		);
		process.exit(2);
	}
	const dimMap = Object.fromEntries(
		(values["dim-map"] ?? []).map(
			(pair) => pair.split("=", 2) as [string, string],
		),
	);
	const batch = orExit(() =>
		positiveNumber("batch", values.batch as string, { integer: true }),
	);
	const date = orExit(() => {
		if (values.date === undefined) return undefined;
		const ms = Date.parse(values.date);
		if (Number.isNaN(ms))
			throw new Error(
				`--date must be a date like 2026-01-31, got "${values.date}"`,
			);
		return ms;
	});
	try {
		const r = await runImport({
			url: values.url,
			token: values.token,
			src: values.src,
			batch,
			date,
			statePath: values.state ?? "import-state.json",
			dims: values.dims?.split(","),
			dimMap,
		});
		console.log(
			`done: ${r.uploaded} tiles uploaded, ${r.skipped} empty tiles skipped, ${r.batches} batches`,
		);
	} catch (err) {
		console.error(
			`import stopped: ${err instanceof Error ? err.message : err}`,
		);
		console.error("Run the same command again to resume.");
		process.exit(1);
	}
}

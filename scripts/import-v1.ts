import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

/**
 * Imports the zoom 0 tiles of the old (v1) map through the public API only.
 *
 * v1 wrote `<src>/<dimension>/0/<x>_<z>.png`, where x and z are the block coordinates of the
 * tile's top-left corner and black pixels mean "no data" (the same convention as uploads).
 */

export type ImportOptions = {
	url: string;
	token: string;
	/** Slug of the target map. */
	map: string;
	/** v1 output directory (contains one folder per dimension). */
	src: string;
	batch?: number;
	maxBatchBytes?: number;
	/** JSON file that remembers finished files so an interrupted run can resume. */
	statePath?: string;
	/** Only import these v1 dimension folders. */
	dims?: string[];
	/** v1 folder name -> dimension slug, when they differ. */
	dimMap?: Record<string, string>;
	pollMs?: number;
	fetch?: typeof fetch;
	log?: (message: string) => void;
};

export type ImportResult = {
	uploaded: number;
	skipped: number;
	batches: number;
};

type State = { version: 1; done: Record<string, string[]> };

const TILE_NAME = /^(-?\d+)_(-?\d+)\.png$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadState(path: string | undefined): Promise<State> {
	if (!path || !existsSync(path)) return { version: 1, done: {} };
	const parsed = JSON.parse(await readFile(path, "utf8")) as State;
	if (parsed.version !== 1)
		throw new Error(`unknown state file version in ${path}`);
	return parsed;
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
	const batchSize = opts.batch ?? 200;
	const maxBytes = opts.maxBatchBytes ?? 100 * 1024 * 1024;
	const pollMs = opts.pollMs ?? 1500;

	const mapRes = await f(`${base}/api/maps/${encodeURIComponent(opts.map)}`, {
		headers: auth,
	});
	if (!mapRes.ok)
		throw new Error(`cannot open map "${opts.map}" (HTTP ${mapRes.status})`);
	const map = (await mapRes.json()) as {
		map: { tileSize: number };
		role: string;
		dimensions: { slug: string }[];
	};
	if (map.role === "viewer")
		throw new Error("this token's user may not upload to that map");
	if (map.map.tileSize !== 512) {
		log(
			`warning: the map's tile size is ${map.map.tileSize}; v1 tiles are 512 blocks, so tiles will be re-cut`,
		);
	}
	const known = new Set(map.dimensions.map((d) => d.slug));

	const folders = (await readdir(opts.src, { withFileTypes: true }))
		.filter((e) => e.isDirectory() && existsSync(join(opts.src, e.name, "0")))
		.map((e) => e.name)
		.filter((name) => !opts.dims || opts.dims.includes(name))
		.sort();
	if (folders.length === 0)
		throw new Error(`no <dimension>/0 folders found in ${opts.src}`);

	const state = await loadState(opts.statePath);
	const result: ImportResult = { uploaded: 0, skipped: 0, batches: 0 };

	for (const folder of folders) {
		const slug = opts.dimMap?.[folder] ?? folder;
		if (!known.has(slug)) {
			throw new Error(
				`dimension "${slug}" does not exist on map "${opts.map}"; add it in Manage > Dimensions first`,
			);
		}
		const dir = join(opts.src, folder, "0");
		const finished = new Set(state.done[folder] ?? []);
		const files = (await readdir(dir))
			.filter((name) => TILE_NAME.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const todo = files.filter((name) => !finished.has(name));
		log(
			`${folder}: ${files.length} tiles, ${files.length - todo.length} already done`,
		);

		// Batches are bounded by file count and by total size.
		const batches: { name: string; bytes: Uint8Array }[][] = [];
		let current: { name: string; bytes: Uint8Array }[] = [];
		let size = 0;
		for (const name of todo) {
			const bytes = new Uint8Array(await readFile(join(dir, name)));
			if (
				current.length > 0 &&
				(current.length >= batchSize || size + bytes.length > maxBytes)
			) {
				batches.push(current);
				current = [];
				size = 0;
			}
			current.push({ name, bytes });
			size += bytes.length;
		}
		if (current.length > 0) batches.push(current);

		for (const [i, batch] of batches.entries()) {
			const outcome = await uploadBatch(batch);
			result.batches++;
			if (outcome === "empty") result.skipped += batch.length;
			else result.uploaded += batch.length;
			state.done[folder] = [
				...(state.done[folder] ?? []),
				...batch.map((b) => b.name),
			];
			await saveState(opts.statePath, state);
			log(
				`${folder}: batch ${i + 1}/${batches.length} ${outcome} (${batch.length} tiles)`,
			);
		}

		async function uploadBatch(
			batch: { name: string; bytes: Uint8Array }[],
		): Promise<"done" | "empty"> {
			const form = new FormData();
			for (const { name, bytes } of batch)
				form.append("files[]", new File([bytes as BlobPart], name));
			form.append(
				"coords",
				JSON.stringify(
					batch.map(({ name }) => {
						const m = TILE_NAME.exec(name) as RegExpExecArray;
						return { x: Number(m[1]), z: Number(m[2]) };
					}),
				),
			);

			let revisionId = 0;
			for (let attempt = 0; ; attempt++) {
				const res = await f(
					`${base}/api/maps/${encodeURIComponent(opts.map)}/dimensions/${encodeURIComponent(slug)}/uploads`,
					{
						method: "POST",
						headers: auth,
						body: form,
					},
				);
				if (res.status === 202) {
					revisionId = ((await res.json()) as { revisionId: number })
						.revisionId;
					break;
				}
				if (res.status === 429 && attempt < 20) {
					log("rate limited, waiting 15 s");
					await sleep(15_000);
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

			for (;;) {
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
			map: { type: "string" },
			src: { type: "string" },
			batch: { type: "string", default: "200" },
			state: { type: "string" },
			dims: { type: "string" },
			"dim-map": { type: "string", multiple: true },
		},
	});
	if (!values.url || !values.token || !values.map || !values.src) {
		console.error(
			"usage: bun scripts/import-v1.ts --url https://map.example.com --token aomc_... --map aomc --src /path/to/v1/data/output\n" +
				"       [--batch 200] [--state import-state.json] [--dims overworld,nether] [--dim-map v1name=slug]\n" +
				"       (the token can also come from the AOMC_TOKEN environment variable)",
		);
		process.exit(2);
	}
	const dimMap = Object.fromEntries(
		(values["dim-map"] ?? []).map(
			(pair) => pair.split("=", 2) as [string, string],
		),
	);
	try {
		const r = await runImport({
			url: values.url,
			token: values.token,
			map: values.map,
			src: values.src,
			batch: Number(values.batch),
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

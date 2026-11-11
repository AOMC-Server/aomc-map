import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "../server/src/db/client";
import { recordStorage } from "../server/src/storage";
import { orExit, positiveNumber } from "./args";
import { type BlobFileKind, classifyBlobFile, referencedBlobs } from "./blobs";

export type GcResult = {
	total: number;
	referenced: number;
	unreferenced: string[];
	skippedYoung: number;
	deleted: number;
	bytes: number;
};

type Candidate = {
	rel: string;
	kind: BlobFileKind;
	hash: string | null;
	size: number;
};

/** Where condemned files wait, inside the data directory so moving them is a cheap rename. */
const QUARANTINE = "gc-quarantine";

function readState(dbFile: string) {
	const db = new Database(dbFile, { readonly: true });
	try {
		const busy = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','processing')",
				)
				.get() as { n: number }
		).n;
		return { referenced: referencedBlobs(db), busy };
	} finally {
		db.close();
	}
}

/** Moves quarantined files back unless the blob store has written the same file again meanwhile. */
async function restore(quarantine: string, blobsDir: string, rels: string[]) {
	for (const rel of rels) {
		const target = join(blobsDir, rel);
		if (existsSync(target)) continue;
		await mkdir(dirname(target), { recursive: true });
		await rename(join(quarantine, rel), target);
	}
}

/**
 * Finds blobs that no tile version and no upload patch points to (left behind by failed jobs or
 * deleted uploads) and optionally deletes them.
 *
 * Refuses to delete while jobs are pending: a running job writes its blobs before the database row
 * that references them. Files younger than `minAgeMs` are always kept for the same reason; the
 * blob store refreshes a blob's age whenever a job reuses it, so an old orphan is not at risk.
 *
 * A scan can take long enough for a job to start meanwhile, so deleting is done in steps: each
 * candidate is checked once more and moved into a quarantine folder, then the database is read
 * again, and whatever has become referenced or young (or everything, if a job has appeared) is
 * moved back before the rest is deleted. A blob a job writes while its old copy is in quarantine
 * is simply a new file, which is kept.
 */
export async function gcBlobs(opts: {
	dataDir: string;
	deleteFiles: boolean;
	minAgeMs?: number;
	now?: number;
	/** Called between the steps of a deleting run; lets tests act as a job would. */
	onStage?: (stage: "scanned" | "quarantined") => void | Promise<void>;
}): Promise<GcResult> {
	const dbFile = join(opts.dataDir, "db.sqlite");
	if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
	const minAge = opts.minAgeMs ?? 3_600_000;
	if (!Number.isFinite(minAge) || minAge < 0)
		throw new Error("minAgeMs must be a number of at least 0");
	const clock = () => opts.now ?? Date.now();
	const blobsDir = join(opts.dataDir, "blobs");
	const quarantine = join(opts.dataDir, QUARANTINE);

	// A run that was killed halfway left its files in quarantine; judge them afresh.
	if (opts.deleteFiles && existsSync(quarantine)) {
		await restore(
			quarantine,
			blobsDir,
			(await readdir(quarantine, { recursive: true })).filter((rel) =>
				classifyBlobFile(basename(rel)),
			),
		);
		await rm(quarantine, { recursive: true, force: true });
	}

	const first = readState(dbFile);
	if (opts.deleteFiles && first.busy > 0) {
		throw new Error(
			`${first.busy} job(s) are still pending or processing; try again when the queue is empty`,
		);
	}

	const result: GcResult = {
		total: 0,
		referenced: 0,
		unreferenced: [],
		skippedYoung: 0,
		deleted: 0,
		bytes: 0,
	};
	if (!existsSync(blobsDir)) return result;

	const candidates: Candidate[] = [];
	for (const rel of await readdir(blobsDir, { recursive: true })) {
		const file = classifyBlobFile(basename(rel));
		if (!file) continue;
		if (file.kind === "blob") result.total++;
		if (file.kind === "blob" && first.referenced.has(file.hash as string)) {
			result.referenced++;
			continue;
		}
		if (file.kind === "copy" && first.referenced.has(file.hash as string))
			continue;
		const info = await stat(join(blobsDir, rel));
		if (clock() - info.mtimeMs < minAge) {
			result.skippedYoung++;
			continue;
		}
		candidates.push({ rel, ...file, size: info.size });
	}

	if (!opts.deleteFiles) {
		result.unreferenced = candidates.map((c) => join(blobsDir, c.rel));
		result.bytes = candidates.reduce((n, c) => n + c.size, 0);
		return result;
	}

	await opts.onStage?.("scanned");
	const moved: Candidate[] = [];
	try {
		for (const c of candidates) {
			const file = join(blobsDir, c.rel);
			const info = await stat(file).catch(() => null);
			if (!info) continue;
			if (clock() - info.mtimeMs < minAge) {
				result.skippedYoung++;
				continue;
			}
			await mkdir(dirname(join(quarantine, c.rel)), { recursive: true });
			await rename(file, join(quarantine, c.rel));
			moved.push({ ...c, size: info.size });
		}
		await opts.onStage?.("quarantined");

		const again = readState(dbFile);
		if (again.busy > 0) {
			await restore(
				quarantine,
				blobsDir,
				moved.map((c) => c.rel),
			);
			moved.length = 0;
			throw new Error(
				`${again.busy} job(s) started while the blobs were being checked; nothing was deleted, try again when the queue is empty`,
			);
		}
		const keep: string[] = [];
		const doomed: Candidate[] = [];
		for (const c of moved) {
			const info = await stat(join(quarantine, c.rel));
			// The blob store refreshes the age of a blob it reuses, even one moved away a moment
			// ago, and writes it anew if it finds it gone.
			if (
				(c.hash && again.referenced.has(c.hash)) ||
				clock() - info.mtimeMs < minAge ||
				existsSync(join(blobsDir, c.rel))
			) {
				keep.push(c.rel);
				result.skippedYoung++;
			} else doomed.push(c);
		}
		await restore(quarantine, blobsDir, keep);
		result.unreferenced = doomed.map((c) => join(blobsDir, c.rel));
		result.bytes = doomed.reduce((n, c) => n + c.size, 0);
		result.deleted = doomed.length;
		moved.length = 0;
		moved.push(...doomed);
	} catch (err) {
		// Whatever is still in quarantine is not condemned yet.
		if (moved.length > 0)
			await restore(
				quarantine,
				blobsDir,
				moved.map((c) => c.rel),
			).catch(() => {});
		throw err;
	} finally {
		await rm(quarantine, { recursive: true, force: true });
	}
	if (result.deleted > 0)
		forgetBlobs(
			dbFile,
			moved.filter((c) => c.kind === "blob").map((c) => c.hash as string),
		);
	return result;
}

/** Drops the size records of deleted blobs and adds a storage history row. */
function forgetBlobs(dbFile: string, hashes: string[]) {
	const db = createDb(dbFile);
	// A database the server has not migrated yet has no size records to update.
	const tracked = db.$client
		.query("SELECT 1 FROM sqlite_master WHERE name = 'blobs'")
		.get();
	if (!tracked) {
		db.$client.close();
		return;
	}
	const del = db.$client.prepare("DELETE FROM blobs WHERE hash = ?");
	db.transaction(() => {
		for (const hash of hashes) del.run(hash);
	});
	recordStorage(db, "gc");
	db.$client.close();
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			data: { type: "string", default: process.env.DATA_DIR ?? "./data" },
			delete: { type: "boolean", default: false },
			"min-age-minutes": { type: "string", default: "60" },
		},
	});
	const minAgeMs =
		orExit(() =>
			positiveNumber("min-age-minutes", values["min-age-minutes"] as string),
		) * 60_000;
	const r = await gcBlobs({
		dataDir: values.data as string,
		deleteFiles: values.delete as boolean,
		minAgeMs,
	});
	const mb = (r.bytes / 1024 / 1024).toFixed(1);
	console.log(
		`${r.total} blobs, ${r.referenced} referenced, ${r.skippedYoung} too new to judge`,
	);
	console.log(
		values.delete
			? `deleted ${r.deleted} unreferenced files (${mb} MB)`
			: `${r.unreferenced.length} unreferenced files (${mb} MB). Run again with --delete to remove them.`,
	);
}

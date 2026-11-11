import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "../server/src/db/client";
import { recordStorage } from "../server/src/storage";
import { isBlobHash } from "../server/src/tiles/blobstore";
import { formatOfSuffix } from "../server/src/tiles/formats";

export type GcResult = {
	total: number;
	referenced: number;
	unreferenced: string[];
	skippedYoung: number;
	deleted: number;
	bytes: number;
};

/**
 * Finds blobs that no tile version and no upload patch points to (left behind by failed jobs or
 * deleted uploads) and optionally deletes them.
 *
 * Refuses to delete while jobs are pending: a running job writes its blobs before the database row
 * that references them. Files younger than `minAgeMs` are always kept for the same reason; the
 * blob store refreshes a blob's age whenever a job reuses it, so an old orphan is not at risk.
 */
export async function gcBlobs(opts: {
	dataDir: string;
	deleteFiles: boolean;
	minAgeMs?: number;
	now?: number;
}): Promise<GcResult> {
	const dbFile = join(opts.dataDir, "db.sqlite");
	if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
	const minAge = opts.minAgeMs ?? 3_600_000;
	const now = opts.now ?? Date.now();

	const db = new Database(dbFile, { readonly: true });
	let referenced: Set<string>;
	let busy: number;
	try {
		referenced = new Set(
			(
				db
					.query(
						"SELECT blob_hash AS h FROM tile_versions WHERE blob_hash IS NOT NULL UNION SELECT blob_hash FROM upload_patches",
					)
					.all() as { h: string }[]
			).map((r) => r.h),
		);
		busy = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','processing')",
				)
				.get() as { n: number }
		).n;
	} finally {
		db.close();
	}
	if (opts.deleteFiles && busy > 0) {
		throw new Error(
			`${busy} job(s) are still pending or processing; try again when the queue is empty`,
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
	const removed: string[] = [];
	const blobsDir = join(opts.dataDir, "blobs");
	if (!existsSync(blobsDir)) return result;

	for (const rel of await readdir(blobsDir, { recursive: true })) {
		const file = join(blobsDir, rel);
		const name = basename(rel);
		const isBlob = name.endsWith(".webp") && isBlobHash(name.slice(0, -5));
		// A copy in another format made for API clients; it goes when its WebP does.
		const isCopy =
			!isBlob &&
			isBlobHash(name.slice(0, 64)) &&
			name[64] === "." &&
			formatOfSuffix(name.slice(65)) !== undefined;
		const isTemp = name.endsWith(".tmp");
		if (!isBlob && !isCopy && !isTemp) continue;
		if (isBlob) result.total++;
		if (isBlob && referenced.has(name.slice(0, -5))) {
			result.referenced++;
			continue;
		}
		if (isCopy && referenced.has(name.slice(0, 64))) continue;
		const info = await stat(file);
		if (now - info.mtimeMs < minAge) {
			result.skippedYoung++;
			continue;
		}
		result.unreferenced.push(file);
		result.bytes += info.size;
		if (opts.deleteFiles) {
			await rm(file, { force: true });
			result.deleted++;
			if (isBlob) removed.push(name.slice(0, -5));
		}
	}
	if (result.deleted > 0) forgetBlobs(dbFile, removed);
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
	const r = await gcBlobs({
		dataDir: values.data as string,
		deleteFiles: values.delete as boolean,
		minAgeMs: Number(values["min-age-minutes"]) * 60_000,
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

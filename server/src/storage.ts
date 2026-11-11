import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { blobFiles, storageHistory } from "./db/schema";
import { isBlobHash } from "./tiles/blobstore";

export type StorageReason = (typeof storageHistory.$inferInsert)["reason"];

const REFERENCED = sql`SELECT blob_hash FROM tile_versions WHERE blob_hash IS NOT NULL UNION SELECT blob_hash FROM upload_patches`;

/** Storage as recorded in the database: summed from the blob sizes, nothing is read from disk. */
export function measureStorage(db: Db) {
	const [all] = db.all<{ n: number; bytes: number }>(
		sql`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM blobs`,
	);
	const [used] = db.all<{ n: number; bytes: number }>(
		sql`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM blobs WHERE hash IN (${REFERENCED})`,
	);
	const [pages] = db.all<{ page_count: number }>(sql`PRAGMA page_count`);
	const [pageSize] = db.all<{ page_size: number }>(sql`PRAGMA page_size`);
	return {
		blobCount: all?.n ?? 0,
		blobBytes: all?.bytes ?? 0,
		referencedBlobs: used?.n ?? 0,
		referencedBytes: used?.bytes ?? 0,
		dbBytes: (pages?.page_count ?? 0) * (pageSize?.page_size ?? 0),
	};
}

/** Appends the current storage figures to the history. */
export function recordStorage(db: Db, reason: StorageReason, at = Date.now()) {
	db.insert(storageHistory)
		.values({ at, reason, ...measureStorage(db) })
		.run();
}

/**
 * Records the size of every blob file that has none yet (written before sizes were tracked).
 * Reads the blob directory, but only stats the files it has not seen.
 */
export async function recordMissingBlobSizes(
	db: Db,
	blobsDir: string,
): Promise<number> {
	const known = new Set(
		db
			.select({ hash: blobFiles.hash })
			.from(blobFiles)
			.all()
			.map((r) => r.hash),
	);
	let names: string[];
	try {
		names = await readdir(blobsDir, { recursive: true });
	} catch {
		return 0;
	}
	let added = 0;
	for (const rel of names) {
		const name = basename(rel);
		if (!name.endsWith(".webp")) continue;
		const hash = name.slice(0, -5);
		if (!isBlobHash(hash) || known.has(hash)) continue;
		const info = await stat(join(blobsDir, rel));
		db.insert(blobFiles)
			.values({ hash, bytes: info.size, createdAt: Math.round(info.mtimeMs) })
			.onConflictDoNothing()
			.run();
		added++;
	}
	return added;
}

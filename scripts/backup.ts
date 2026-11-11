import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { orExit, positiveNumber } from "./args";
import { webpBlobHash } from "./blobs";

/** UTC, millisecond precision, so names sort by time and runs never collide. */
const stamp = (d: Date) => d.toISOString().replace(/[-:.]/g, "");

export type BackupResult = {
	snapshot: string;
	blobsCopied: number;
	blobsSkipped: number;
	pruned: string[];
};

/**
 * Takes a consistent snapshot of the database (VACUUM INTO, safe while the server runs) and copies
 * any blobs the destination does not have yet.
 *
 * Blobs are content-addressed and immutable, so "exists" means "identical" and the destination
 * only ever grows. The database goes first: a blob is always written before the row that points to
 * it, so everything the snapshot references is already on disk when the blobs are copied.
 */
export async function backup(opts: {
	dataDir: string;
	dest: string;
	keep?: number;
	now?: Date;
}): Promise<BackupResult> {
	const dbFile = join(opts.dataDir, "db.sqlite");
	if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
	if (opts.keep !== undefined)
		positiveNumber("keep", opts.keep, { integer: true });
	await mkdir(opts.dest, { recursive: true });

	const snapshot = join(
		opts.dest,
		`db-${stamp(opts.now ?? new Date())}.sqlite`,
	);
	const db = new Database(dbFile, { readonly: true });
	try {
		db.query("VACUUM INTO ?").run(snapshot);
	} finally {
		db.close();
	}

	let blobsCopied = 0;
	let blobsSkipped = 0;
	const blobsDir = join(opts.dataDir, "blobs");
	if (existsSync(blobsDir)) {
		for (const rel of await readdir(blobsDir, { recursive: true })) {
			if (!webpBlobHash(basename(rel))) continue; // skips copies and in-progress .tmp files
			const target = join(opts.dest, "blobs", rel);
			if (existsSync(target)) {
				blobsSkipped++;
				continue;
			}
			await mkdir(dirname(target), { recursive: true });
			// Copy under a temporary name so an interrupted run never leaves a truncated blob.
			await copyFile(join(blobsDir, rel), `${target}.tmp`);
			await rename(`${target}.tmp`, target);
			blobsCopied++;
		}
	}

	const pruned: string[] = [];
	if (opts.keep !== undefined) {
		const snapshots = (await readdir(opts.dest))
			.filter((n) => /^db-.*\.sqlite$/.test(n))
			.sort();
		for (const old of snapshots.slice(
			0,
			Math.max(0, snapshots.length - opts.keep),
		)) {
			await rm(join(opts.dest, old));
			pruned.push(old);
		}
	}
	return { snapshot, blobsCopied, blobsSkipped, pruned };
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			data: { type: "string", default: process.env.DATA_DIR ?? "./data" },
			keep: { type: "string", default: "14" },
		},
	});
	const dest = positionals[0];
	if (!dest) {
		console.error(
			"usage: bun scripts/backup.ts <destination-dir> [--data ./data] [--keep 14]",
		);
		process.exit(2);
	}
	const keep = orExit(() =>
		positiveNumber("keep", values.keep as string, { integer: true }),
	);
	const result = await backup({ dataDir: values.data as string, dest, keep });
	console.log(`database: ${result.snapshot}`);
	console.log(
		`blobs: ${result.blobsCopied} copied, ${result.blobsSkipped} already there`,
	);
	if (result.pruned.length > 0)
		console.log(`removed old snapshots: ${result.pruned.join(", ")}`);
}

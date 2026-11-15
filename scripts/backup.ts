import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import * as paths from "../server/src/paths";
import { webpBlobHash } from "../server/src/tiles/blobstore";
import { orExit, positiveNumber } from "./args";

/** UTC, millisecond precision, so names sort by time and runs never collide. */
const stamp = (d: Date) => d.toISOString().replace(/[-:.]/g, "");

export type BackupResult = {
	snapshot: string;
	blobsCopied: number;
	blobsSkipped: number;
	filesCopied: number;
	filesSkipped: number;
	pruned: string[];
};

/** Copies under a temporary name, so an interrupted run never leaves a truncated copy. */
async function copyNew(from: string, to: string): Promise<boolean> {
	if (existsSync(to)) return false;
	await mkdir(dirname(to), { recursive: true });
	await copyFile(from, `${to}.tmp`);
	await rename(`${to}.tmp`, to);
	return true;
}

/**
 * Takes a consistent snapshot of the database (VACUUM INTO, safe while the server runs) and copies
 * any blobs and file library contents the destination does not have yet (`skipFiles` leaves the
 * file library out, as it can be large).
 *
 * Blobs are content-addressed and immutable, so "exists" means "identical" and the destination
 * only ever grows. The same goes for the file library's contents. The database goes first: content
 * is always written before the row that points to it, so everything the snapshot references is
 * already on disk when the contents are copied.
 */
export async function backup(opts: {
	dataDir: string;
	dest: string;
	keep?: number;
	now?: Date;
	skipFiles?: boolean;
}): Promise<BackupResult> {
	const dbFile = paths.dbFile(opts.dataDir);
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
	const blobsDir = paths.blobsDir(opts.dataDir);
	if (existsSync(blobsDir)) {
		for (const rel of await readdir(blobsDir, { recursive: true })) {
			if (!webpBlobHash(basename(rel))) continue; // skips copies and in-progress .tmp files
			if (await copyNew(join(blobsDir, rel), join(opts.dest, "blobs", rel)))
				blobsCopied++;
			else blobsSkipped++;
		}
	}

	let filesCopied = 0;
	let filesSkipped = 0;
	const filesDir = paths.filesDir(opts.dataDir);
	if (!opts.skipFiles && existsSync(filesDir)) {
		for (const name of await readdir(filesDir)) {
			if (!/^[0-9a-f]{64}$/.test(name)) continue; // skips uploads in progress
			if (await copyNew(join(filesDir, name), join(opts.dest, "files", name)))
				filesCopied++;
			else filesSkipped++;
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
	return {
		snapshot,
		blobsCopied,
		blobsSkipped,
		filesCopied,
		filesSkipped,
		pruned,
	};
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			data: { type: "string", default: process.env.DATA_DIR ?? "./data" },
			keep: { type: "string", default: "14" },
			"skip-files": { type: "boolean", default: false },
		},
	});
	const dest = positionals[0];
	if (!dest) {
		console.error(
			"usage: bun scripts/backup.ts <destination-dir> [--data ./data] [--keep 14] [--skip-files]",
		);
		process.exit(2);
	}
	const keep = orExit(() =>
		positiveNumber("keep", values.keep as string, { integer: true }),
	);
	const result = await backup({
		dataDir: values.data as string,
		dest,
		keep,
		skipFiles: values["skip-files"] as boolean,
	});
	console.log(`database: ${result.snapshot}`);
	console.log(
		`blobs: ${result.blobsCopied} copied, ${result.blobsSkipped} already there`,
	);
	if (!values["skip-files"])
		console.log(
			`files: ${result.filesCopied} copied, ${result.filesSkipped} already there`,
		);
	if (result.pruned.length > 0)
		console.log(`removed old snapshots: ${result.pruned.join(", ")}`);
}

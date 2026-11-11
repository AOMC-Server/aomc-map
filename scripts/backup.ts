import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
	`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else yield path;
	}
}

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
	await mkdir(opts.dest, { recursive: true });

	// Two runs in the same second get -1, -2, ... instead of overwriting or failing.
	const base = `db-${stamp(opts.now ?? new Date())}`;
	let snapshot = join(opts.dest, `${base}.sqlite`);
	for (let n = 1; existsSync(snapshot); n++) {
		snapshot = join(opts.dest, `${base}-${n}.sqlite`);
	}
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
		for await (const file of walk(blobsDir)) {
			if (!file.endsWith(".webp")) continue; // skips in-progress .tmp files
			const target = join(opts.dest, "blobs", file.slice(blobsDir.length + 1));
			if (existsSync(target)) {
				blobsSkipped++;
				continue;
			}
			await mkdir(join(target, ".."), { recursive: true });
			await copyFile(file, target);
			blobsCopied++;
		}
	}

	const pruned: string[] = [];
	if (opts.keep !== undefined) {
		// Oldest first: by timestamp, then by the -N suffix (a plain "." would sort after "-").
		const order = (name: string) => {
			const m = /^db-(\d{8}-\d{6})(?:-(\d+))?\.sqlite$/.exec(name);
			return m ? `${m[1]}-${String(m[2] ?? 0).padStart(6, "0")}` : null;
		};
		const snapshots = (await readdir(opts.dest))
			.filter((n) => order(n) !== null)
			.sort((a, b) => (order(a) as string).localeCompare(order(b) as string));
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
	const result = await backup({
		dataDir: values.data as string,
		dest,
		keep: Number(values.keep),
	});
	console.log(`database: ${result.snapshot}`);
	console.log(
		`blobs: ${result.blobsCopied} copied, ${result.blobsSkipped} already there`,
	);
	if (result.pruned.length > 0)
		console.log(`removed old snapshots: ${result.pruned.join(", ")}`);
}

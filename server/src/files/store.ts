import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomToken } from "../auth/tokens";

const HASH_RE = /^[0-9a-f]{64}$/;

/** The upload sent more than it announced, or more than is allowed. */
export class TooLargeError extends Error {}

export type Received = { tmp: string; hash: string; bytes: number };

export type FileStore = ReturnType<typeof createFileStore>;

/**
 * The contents of the file library, one file per distinct content, named by its sha256. Uploads
 * stream into `tmp/` and are moved into place once complete, so a stored file is never partial.
 */
export function createFileStore(dir: string) {
	const tmpDir = join(dir, "tmp");
	const path = (hash: string) => join(dir, hash);

	// Placing contents and removing unused ones take turns, so a removal never deletes a file
	// that an upload of the same content has just been told is already there.
	let turn: Promise<unknown> = Promise.resolve();
	function exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = turn.then(fn, fn);
		turn = run.catch(() => {});
		return run;
	}

	/** Bytes promised to uploads that are still arriving, so they can't all fit in the same room. */
	let reserved = 0;

	return {
		path,
		file: (hash: string) => Bun.file(path(hash)),
		exclusive,

		/** Holds room for an upload of `bytes`, or null when `used` plus what is held leaves too little. */
		reserve(bytes: number, used: number, quota: number) {
			if (used + reserved + bytes > quota) return null;
			reserved += bytes;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				reserved -= bytes;
			};
		},

		/** Writes the body to a temporary file, hashing it on the way; throws TooLargeError past `maxBytes`. */
		async receive(
			body: ReadableStream<Uint8Array> | null,
			maxBytes: number,
		): Promise<Received> {
			await mkdir(tmpDir, { recursive: true });
			const tmp = join(tmpDir, `${randomToken(9)}.tmp`);
			const hasher = new Bun.CryptoHasher("sha256");
			let bytes = 0;
			const sink = Bun.file(tmp).writer({ highWaterMark: 1024 * 1024 });
			try {
				const reader = body?.getReader();
				while (reader) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > maxBytes) {
						await reader.cancel().catch(() => {});
						throw new TooLargeError("upload too large");
					}
					hasher.update(value);
					const pending = sink.write(value);
					if (pending instanceof Promise) await pending;
				}
				await sink.end();
				const handle = await open(tmp, "r+");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
			} catch (err) {
				await Promise.resolve(sink.end()).catch(() => {});
				await rm(tmp, { force: true });
				throw err;
			}
			return { tmp, hash: hasher.digest("hex"), bytes };
		},

		/** Moves received content into place, or drops it when the same content is already stored. Call inside `exclusive`. */
		async place(received: Received) {
			if (await Bun.file(path(received.hash)).exists())
				await rm(received.tmp, { force: true });
			else await rename(received.tmp, path(received.hash));
		},

		discard: (received: Received) => rm(received.tmp, { force: true }),

		/** Deletes the contents no file uses any more. Call inside `exclusive`. */
		async removeUnused(
			hashes: Iterable<string>,
			isUsed: (hash: string) => boolean,
		) {
			for (const hash of new Set(hashes)) {
				if (HASH_RE.test(hash) && !isUsed(hash))
					await rm(path(hash), { force: true });
			}
		},

		/** On start: drops uploads that were cut off, and contents left behind by a crash. */
		async sweep(used: Set<string>) {
			await rm(tmpDir, { recursive: true, force: true });
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				return;
			}
			for (const name of names) {
				if (HASH_RE.test(name) && !used.has(name))
					await rm(path(name), { force: true });
			}
		},
	};
}

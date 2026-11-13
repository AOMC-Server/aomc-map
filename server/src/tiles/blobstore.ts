import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomToken } from "../auth/tokens";
import {
	type DerivedFormat,
	formatOfSuffix,
	TILE_FORMATS,
	type TileFormat,
	transcode,
} from "./formats";

/** Writes through a temporary file, synced before the rename so a crash never leaves a truncated blob. */
async function writeAtomic(target: string, data: Uint8Array): Promise<void> {
	const tmp = `${target}.${randomToken(6)}.tmp`;
	try {
		const handle = await open(tmp, "w");
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, target);
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

export type BlobStore = ReturnType<typeof createBlobStore>;

const HASH_RE = /^[0-9a-f]{64}$/;

export function isBlobHash(value: string): boolean {
	return HASH_RE.test(value);
}

/** `<sha256>.<suffix>`, a stored tile or a copy of it in another format; null for any other name. */
export function parseBlobName(
	name: string,
): { hash: string; format: TileFormat } | null {
	const hash = name.slice(0, 64);
	const format = formatOfSuffix(name.slice(65));
	return isBlobHash(hash) && name[64] === "." && format
		? { hash, format }
		: null;
}

export type BlobFileKind =
	/** `<hash>.webp`, the stored tile. */
	| "blob"
	/** `<hash>.<suffix>`, a copy in another format made for API clients. */
	| "copy"
	/** An unfinished write. */
	| "temp";

/** What a file in the blob directory is, by its base name; null for anything else. */
export function classifyBlobFile(
	name: string,
): { kind: BlobFileKind; hash: string | null } | null {
	const parsed = parseBlobName(name);
	if (parsed) {
		return {
			kind: parsed.format === "webp" ? "blob" : "copy",
			hash: parsed.hash,
		};
	}
	if (name.endsWith(".tmp")) return { kind: "temp", hash: null };
	return null;
}

/** The hash of a stored tile `<hash>.webp`, or null for any other file. */
export function webpBlobHash(name: string): string | null {
	const file = classifyBlobFile(name);
	return file?.kind === "blob" ? file.hash : null;
}

/**
 * Content-addressed WebP storage: blobs/ab/cd/<sha256>.webp, plus <sha256>.<suffix> copies in
 * other formats (see ./formats) once they are asked for.
 */
export function createBlobStore(
	root: string,
	/** Called with the size of every blob that is put, whether or not it was already stored. */
	onPut?: (hash: string, bytes: number) => void,
) {
	function path(hash: string): string {
		if (!isBlobHash(hash)) throw new Error("invalid blob hash");
		return join(root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.webp`);
	}
	function derivedPath(hash: string, format: DerivedFormat): string {
		return `${path(hash).slice(0, -5)}.${TILE_FORMATS[format].suffix}`;
	}
	/** Conversions in progress, so concurrent requests for one tile convert it once. */
	const converting = new Map<string, Promise<void>>();

	return {
		path,
		async put(data: Uint8Array): Promise<string> {
			const hash = createHash("sha256").update(data).digest("hex");
			const target = path(hash);
			if (await Bun.file(target).exists()) {
				// Reused: refresh the age so scripts/gc-blobs.ts treats it as new. If the file was
				// moved away since the check (gc quarantine), it is written anew below.
				const now = new Date();
				try {
					await utimes(target, now, now);
					onPut?.(hash, data.byteLength);
					return hash;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
			}
			await mkdir(dirname(target), { recursive: true });
			await writeAtomic(target, data);
			onPut?.(hash, data.byteLength);
			return hash;
		},
		read(hash: string): Promise<Buffer> {
			return readFile(path(hash));
		},
		file(hash: string) {
			return Bun.file(path(hash));
		},
		/**
		 * The blob in another format: converted on first use and kept next to the WebP. The WebP
		 * must exist.
		 */
		async derived(hash: string, format: DerivedFormat) {
			const target = derivedPath(hash, format);
			const file = Bun.file(target);
			if (await file.exists()) return file;
			const key = `${hash}.${format}`;
			let pending = converting.get(key);
			if (!pending) {
				pending = (async () => {
					const data = await transcode(await readFile(path(hash)), format);
					await writeAtomic(target, data);
				})().finally(() => converting.delete(key));
				converting.set(key, pending);
			}
			await pending;
			return Bun.file(target);
		},
	};
}

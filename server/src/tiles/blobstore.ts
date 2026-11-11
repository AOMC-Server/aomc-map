import { createHash } from "node:crypto";
import { mkdir, readFile, rename, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomToken } from "../auth/tokens";
import { type DerivedFormat, TILE_FORMATS, transcode } from "./formats";

export type BlobStore = ReturnType<typeof createBlobStore>;

const HASH_RE = /^[0-9a-f]{64}$/;

export function isBlobHash(value: string): boolean {
	return HASH_RE.test(value);
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
				// Reused: refresh the age so scripts/gc-blobs.ts treats it as new.
				const now = new Date();
				await utimes(target, now, now);
				onPut?.(hash, data.byteLength);
				return hash;
			}
			await mkdir(dirname(target), { recursive: true });
			const tmp = `${target}.${randomToken(6)}.tmp`;
			await Bun.write(tmp, data);
			await rename(tmp, target);
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
					const tmp = `${target}.${randomToken(6)}.tmp`;
					await Bun.write(tmp, data);
					await rename(tmp, target);
				})().finally(() => converting.delete(key));
				converting.set(key, pending);
			}
			await pending;
			return Bun.file(target);
		},
	};
}

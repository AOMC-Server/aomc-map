import { createHash } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomToken } from "../auth/tokens";

export type BlobStore = ReturnType<typeof createBlobStore>;

const HASH_RE = /^[0-9a-f]{64}$/;

export function isBlobHash(value: string): boolean {
	return HASH_RE.test(value);
}

/** Content-addressed WebP storage: blobs/ab/cd/<sha256>.webp */
export function createBlobStore(root: string) {
	function path(hash: string): string {
		if (!isBlobHash(hash)) throw new Error("invalid blob hash");
		return join(root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.webp`);
	}

	return {
		path,
		async put(data: Uint8Array): Promise<string> {
			const hash = createHash("sha256").update(data).digest("hex");
			const target = path(hash);
			if (await Bun.file(target).exists()) return hash;
			await mkdir(dirname(target), { recursive: true });
			const tmp = `${target}.${randomToken(6)}.tmp`;
			await Bun.write(tmp, data);
			await rename(tmp, target);
			return hash;
		},
		read(hash: string): Promise<Buffer> {
			return readFile(path(hash));
		},
		file(hash: string) {
			return Bun.file(path(hash));
		},
	};
}

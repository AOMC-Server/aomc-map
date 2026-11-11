import type { Database } from "bun:sqlite";
import { isBlobHash } from "../server/src/tiles/blobstore";
import { formatOfSuffix } from "../server/src/tiles/formats";

// Mirrors REFERENCED in server/src/storage.ts.
const REFERENCED_SQL =
	"SELECT blob_hash AS h FROM tile_versions WHERE blob_hash IS NOT NULL UNION SELECT blob_hash FROM upload_patches";

/** Hashes that a tile version or an upload patch points to. */
export function referencedBlobs(db: Database): Set<string> {
	return new Set(
		(db.query(REFERENCED_SQL).all() as { h: string }[]).map((r) => r.h),
	);
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
	if (name.endsWith(".webp") && isBlobHash(name.slice(0, -5)))
		return { kind: "blob", hash: name.slice(0, -5) };
	if (
		isBlobHash(name.slice(0, 64)) &&
		name[64] === "." &&
		formatOfSuffix(name.slice(65)) !== undefined
	)
		return { kind: "copy", hash: name.slice(0, 64) };
	if (name.endsWith(".tmp")) return { kind: "temp", hash: null };
	return null;
}

/** The hash of a stored tile `<hash>.webp`, or null for any other file. */
export function webpBlobHash(name: string): string | null {
	const file = classifyBlobFile(name);
	return file?.kind === "blob" ? file.hash : null;
}

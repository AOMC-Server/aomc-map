import type { BlobStore } from "./blobstore";
import { composeParent, loadTile, storeTile } from "./compose";

/** One stored version of a tile: from `rev` on it is `hash` (null = empty). */
export type Row = { rev: number; hash: string | null };

export const sameRows = (a: Row[], b: Row[]) =>
	a.length === b.length &&
	a.every((r, i) => r.rev === b[i]?.rev && r.hash === b[i]?.hash);

/**
 * The versions of a zoomed-out tile, from the versions of its four children (in quadrant order:
 * top left, top right, bottom left, bottom right). Before its first row a child is `base`; the
 * parent starts as `base` and gets a row wherever the mix of its children changes it. `mixes`
 * caches composed parents by the hashes of their children and may be shared between calls.
 */
export async function parentRows(opts: {
	blobs: BlobStore;
	tileSize: number;
	kids: { base: string | null; rows: Row[] }[];
	base: string | null;
	mixes: Map<string, string | null>;
}): Promise<Row[]> {
	const { blobs, tileSize: T, kids, mixes } = opts;
	const revs = [...new Set(kids.flatMap((k) => k.rows.map((r) => r.rev)))].sort(
		(a, b) => a - b,
	);
	let prev = opts.base;
	const rows: Row[] = [];
	// Each child's current image, so it is decoded once per version rather than once per rev.
	const held: { hash: string | null; image: Buffer | null }[] = kids.map(
		() => ({ hash: null, image: null }),
	);
	const image = async (q: number, hash: string | null) => {
		const slot = held[q] as (typeof held)[number];
		if (slot.hash !== hash || (hash !== null && slot.image === null)) {
			slot.image = hash ? await loadTile(blobs, hash, T) : null;
			slot.hash = hash;
		}
		return slot.image;
	};
	// How many of each child's rows are at or before the rev being built (revs only go up).
	const seen = kids.map(() => 0);
	for (const rev of revs) {
		const hashes = kids.map((k, q) => {
			let n = seen[q] as number;
			while (n < k.rows.length && (k.rows[n] as Row).rev <= rev) n++;
			seen[q] = n;
			return n > 0 ? (k.rows[n - 1] as Row).hash : k.base;
		});
		const mixKey = hashes.join("|");
		if (!mixes.has(mixKey)) {
			const canvas = composeParent(
				T,
				await Promise.all(hashes.map((hash, q) => image(q, hash))),
			);
			mixes.set(mixKey, canvas ? await storeTile(blobs, canvas, T) : null);
		}
		const hash = mixes.get(mixKey) ?? null;
		if (hash !== prev) {
			rows.push({ rev, hash });
			prev = hash;
		}
	}
	return rows;
}

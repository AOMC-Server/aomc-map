import { floorDiv } from "@aomc/shared";
import { mapLimit } from "../concurrency";
import type { BlobStore } from "./blobstore";
import { composeParent, loadTile, storeTile } from "./compose";

export type TileWrite = {
	zoom: number;
	x: number;
	y: number;
	hash: string | null;
};

export const tileKey = (x: number, y: number) => `${x},${y}`;
export const parseKey = (key: string) =>
	key.split(",").map(Number) as [number, number];

/**
 * Rebuilds all ancestors of the changed zoom 0 tiles up to maxZoom.
 *
 * `changed` maps "x,y" -> new hash (null = now empty) for zoom 0. `current` returns the hash a
 * tile has before this revision. Untouched siblings are read through `current`; tiles whose
 * rebuilt hash equals the current one produce no write, which also stops propagation.
 */
export async function buildPyramid(opts: {
	blobs: BlobStore;
	tileSize: number;
	maxZoom: number;
	changed: Map<string, string | null>;
	current: (zoom: number, x: number, y: number) => Promise<string | null>;
	/** Parents built at once (they are independent within a level). */
	concurrency?: number;
	/** Called as parents are built: the zoom level, how many are done and how many there are. */
	onProgress?: (zoom: number, done: number, total: number) => void;
}): Promise<TileWrite[]> {
	const { blobs, tileSize, maxZoom, current } = opts;
	const writes: TileWrite[] = [];
	let level = opts.changed;

	for (let zoom = 1; zoom <= maxZoom && level.size > 0; zoom++) {
		const parents = new Set<string>();
		for (const key of level.keys()) {
			const [x, y] = parseKey(key);
			parents.add(tileKey(floorDiv(x, 2), floorDiv(y, 2)));
		}

		let finished = 0;
		const built = await mapLimit(
			[...parents],
			opts.concurrency ?? 1,
			async (parentKey) => {
				const [px, py] = parseKey(parentKey);
				const children = await Promise.all(
					[0, 1, 2, 3].map(async (q) => {
						const cx = 2 * px + (q % 2);
						const cy = 2 * py + Math.floor(q / 2);
						const key = tileKey(cx, cy);
						const childHash = level.has(key)
							? (level.get(key) as string | null)
							: await current(zoom - 1, cx, cy);
						return childHash ? loadTile(blobs, childHash, tileSize) : null;
					}),
				);
				const canvas = composeParent(tileSize, children);
				const hash = canvas ? await storeTile(blobs, canvas, tileSize) : null;
				const changed = hash !== (await current(zoom, px, py));
				opts.onProgress?.(zoom, ++finished, parents.size);
				return { parentKey, px, py, hash, changed };
			},
		);
		const next = new Map<string, string | null>();
		for (const { parentKey, px, py, hash, changed } of built) {
			if (!changed) continue;
			next.set(parentKey, hash);
			writes.push({ zoom, x: px, y: py, hash });
		}
		level = next;
	}
	return writes;
}

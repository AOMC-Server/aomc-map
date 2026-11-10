import { floorDiv } from "@aomc/shared";
import type { BlobStore } from "./blobstore";
import { downscaleInto, emptyTile, loadTile, storeTile } from "./compose";

export type TileWrite = {
	zoom: number;
	x: number;
	y: number;
	hash: string | null;
};

export const tileKey = (x: number, y: number) => `${x},${y}`;
const parseKey = (key: string) =>
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

		const next = new Map<string, string | null>();
		for (const parentKey of parents) {
			const [px, py] = parseKey(parentKey);
			const canvas = emptyTile(tileSize);
			for (let j = 0; j < 2; j++) {
				for (let i = 0; i < 2; i++) {
					const cx = 2 * px + i;
					const cy = 2 * py + j;
					const key = tileKey(cx, cy);
					const hash = level.has(key)
						? (level.get(key) as string | null)
						: await current(zoom - 1, cx, cy);
					if (hash)
						downscaleInto(
							canvas,
							await loadTile(blobs, hash, tileSize),
							tileSize,
							i,
							j,
						);
				}
			}
			const hash = await storeTile(blobs, canvas, tileSize);
			if (hash !== (await current(zoom, px, py))) {
				next.set(parentKey, hash);
				writes.push({ zoom, x: px, y: py, hash });
			}
		}
		level = next;
	}
	return writes;
}

import { signal } from "@preact/signals";
import { api } from "./api";
import type { RevisionInfo } from "./state";

/** A rectangle of blocks, min inclusive and max exclusive. */
export type Rect = { x0: number; z0: number; x1: number; z1: number };
/** A straight piece of outline between two block corners. */
export type Edge = { x0: number; z0: number; x1: number; z1: number };

/** Where an upload put map data: its tiles, and the outline around them. */
export type UploadArea = { rects: Rect[]; edges: Edge[] };

/**
 * Turns covered tiles into block rectangles and the outline of their union: only sides that do
 * not border another covered tile, with neighbouring sides on a line joined into one edge.
 */
export function outlineTiles(
	tiles: [number, number][],
	tileSize: number,
): UploadArea {
	const T = tileSize;
	const has = new Set(tiles.map(([x, y]) => `${x},${y}`));
	const covered = (x: number, y: number) => has.has(`${x},${y}`);
	// Unit sides keyed by the line they lie on, as the start of the unit along it.
	const rows = new Map<number, number[]>();
	const cols = new Map<number, number[]>();
	const add = (lines: Map<number, number[]>, line: number, at: number) => {
		const list = lines.get(line);
		if (list) list.push(at);
		else lines.set(line, [at]);
	};
	for (const [x, y] of tiles) {
		if (!covered(x, y - 1)) add(rows, y, x);
		if (!covered(x, y + 1)) add(rows, y + 1, x);
		if (!covered(x - 1, y)) add(cols, x, y);
		if (!covered(x + 1, y)) add(cols, x + 1, y);
	}
	const runs = (lines: Map<number, number[]>) => {
		const out: { line: number; from: number; to: number }[] = [];
		for (const [line, starts] of lines) {
			starts.sort((a, b) => a - b);
			let from = starts[0] as number;
			let to = from + 1;
			for (const s of starts.slice(1)) {
				if (s === to) to++;
				else {
					out.push({ line, from, to });
					from = s;
					to = s + 1;
				}
			}
			out.push({ line, from, to });
		}
		return out;
	};
	const edges: Edge[] = [
		...runs(rows).map((r) => ({
			x0: r.from * T,
			z0: r.line * T,
			x1: r.to * T,
			z1: r.line * T,
		})),
		...runs(cols).map((r) => ({
			x0: r.line * T,
			z0: r.from * T,
			x1: r.line * T,
			z1: r.to * T,
		})),
	];
	const rects = [...has].map((k) => {
		const [x, y] = k.split(",").map(Number) as [number, number];
		return { x0: x * T, z0: y * T, x1: (x + 1) * T, z1: (y + 1) * T };
	});
	return { rects, edges };
}

const areas = new Map<number, UploadArea | null>();
const loading = new Set<number>();
/** Bumped whenever an area finishes loading, so whatever draws them repaints. */
export const areasLoaded = signal(0);

/**
 * The upload's area if it has been loaded (null: there is none, use its bounding box); starts
 * loading it otherwise and returns undefined.
 */
export function uploadArea(r: RevisionInfo): UploadArea | null | undefined {
	if (r.kind !== "upload" || r.status !== "done") return null;
	if (areas.has(r.id)) return areas.get(r.id);
	if (!loading.has(r.id)) {
		loading.add(r.id);
		void fetchArea(r.id);
	}
	return undefined;
}

async function fetchArea(id: number) {
	try {
		const res = await api.api.revisions[":id"].tiles.$get({
			param: { id: String(id) },
		});
		const body = res.ok ? await res.json() : null;
		areas.set(
			id,
			body?.tiles.length ? outlineTiles(body.tiles, body.tileSize) : null,
		);
	} catch {
		// null: outlined by its bounding box instead.
		areas.set(id, null);
	} finally {
		loading.delete(id);
		areasLoaded.value++;
	}
}

import { type Bounds, boundsOf, type Pt } from "./geometry";

export type ClusterNode<T, M> = {
	/** Block position: the pin itself, or the centre of the pins in a cluster. */
	x: number;
	z: number;
	/** Number of pins in the node; 1 for a single pin. */
	count: number;
	/** Blocks of all pins in the node. */
	bounds: Bounds;
	/** The pin, for a single one. */
	item: T | null;
	/** The pin's data, or for a cluster what `Options.combine` made of its pins'. */
	data: M;
};

type Options<M> = {
	/** How far apart (in px, at the level's own scale) pins may be and still merge. */
	radiusPx: number;
	/** The most zoomed in level that is clustered; anything closer shows single pins. */
	minLevel: number;
	/** Past this level the pins are one cluster at most, so nothing more is built. */
	maxLevel: number;
	/** Makes the data of a cluster from the data and pin counts of what it merges. */
	combine: (parts: { data: M; count: number }[]) => M;
};

/**
 * Pin clusters that stay put. They are computed once per integer zoom level from world
 * positions (never from where things are on screen), and each level is built from the one below
 * it. So panning changes nothing, zooming out only ever merges clusters, zooming in only ever
 * splits them, and a cluster is always in the same place at a given level.
 *
 * Level L suits views with zoom in [L + 0.25, L + 1.25) (the layer switches levels a quarter of
 * a level past each integer): its radius is `radiusPx * 2^L` blocks, which is between about 0.4
 * and 0.8 of `radiusPx` on screen.
 */
export class ClusterIndex<T, M> {
	private leaves: ClusterNode<T, M>[];
	/** levels[0] is minLevel. */
	private levels: ClusterNode<T, M>[][] = [];

	constructor(
		points: {
			x: number;
			z: number;
			item: T;
			data: M;
		}[],
		private opts: Options<M>,
	) {
		this.leaves = points.map((p) => ({
			x: p.x,
			z: p.z,
			count: 1,
			bounds: { minX: p.x, minZ: p.z, maxX: p.x, maxZ: p.z },
			item: p.item,
			data: p.data,
		}));
	}

	/** Every pin on its own. */
	singles(): ClusterNode<T, M>[] {
		return this.leaves;
	}

	/** The nodes to show at an integer zoom level. */
	nodes(level: number): ClusterNode<T, M>[] {
		const { minLevel, maxLevel } = this.opts;
		const wanted = Math.min(Math.max(level, minLevel), maxLevel) - minLevel;
		while (this.levels.length <= wanted) {
			const level = minLevel + this.levels.length;
			const below = this.levels.at(-1) ?? this.leaves;
			this.levels.push(
				below.length <= 1
					? below
					: merge(below, this.opts.radiusPx * 2 ** level, this.opts.combine),
			);
		}
		return this.levels[wanted] as ClusterNode<T, M>[];
	}
}

/** Greedy: each node, in order, takes in every node within `radius` that is still free. */
function merge<T, M>(
	nodes: ClusterNode<T, M>[],
	radius: number,
	combine: Options<M>["combine"],
): ClusterNode<T, M>[] {
	const cell = (v: number) => Math.floor(v / radius);
	const grid = new Map<string, number[]>();
	nodes.forEach((n, i) => {
		const key = `${cell(n.x)},${cell(n.z)}`;
		const list = grid.get(key);
		if (list) list.push(i);
		else grid.set(key, [i]);
	});

	const taken = new Array<boolean>(nodes.length).fill(false);
	const out: ClusterNode<T, M>[] = [];
	nodes.forEach((n, i) => {
		if (taken[i]) return;
		taken[i] = true;
		const near: number[] = [];
		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				for (const j of grid.get(`${cell(n.x) + dx},${cell(n.z) + dz}`) ?? []) {
					const o = nodes[j] as ClusterNode<T, M>;
					if (!taken[j] && Math.hypot(o.x - n.x, o.z - n.z) <= radius)
						near.push(j);
				}
			}
		}
		if (near.length === 0) {
			out.push(n);
			return;
		}
		// Ascending, so the result does not depend on the order the grid cells are visited in.
		near.sort((a, b) => a - b);
		const members = [n, ...near.map((j) => nodes[j] as ClusterNode<T, M>)];
		for (const j of near) taken[j] = true;
		const count = members.reduce((sum, m) => sum + m.count, 0);
		const corners: Pt[] = members.flatMap((m) => [
			[m.bounds.minX, m.bounds.minZ] as Pt,
			[m.bounds.maxX, m.bounds.maxZ] as Pt,
		]);
		out.push({
			x: members.reduce((sum, m) => sum + m.x * m.count, 0) / count,
			z: members.reduce((sum, m) => sum + m.z * m.count, 0) / count,
			count,
			bounds: boundsOf(corners),
			item: null,
			data: combine(members),
		});
	});
	return out;
}

import type { Point } from "@aomc/shared/features";

/**
 * A line as the editor holds it: points, each in its own block, and the pairs of them that are
 * joined. A point can join any number of others, so a line can branch and close into loops.
 * It is saved as the fewest paths that cover every joint (see `pathsFromGraph`).
 */
export type Edge = [number, number];
export type LineGraph = { points: Point[]; edges: Edge[] };

const blockKey = ([x, z]: Point) => `${x},${z}`;
const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export const sameEdge = (e: Edge, a: number, b: number) =>
	(e[0] === a && e[1] === b) || (e[0] === b && e[1] === a);

export const hasEdge = (edges: Edge[], a: number, b: number) =>
	edges.some((e) => sameEdge(e, a, b));

/** The points joined to point `i`. */
export const neighbours = (edges: Edge[], i: number): number[] =>
	edges.flatMap(([a, b]) => (a === i ? [b] : b === i ? [a] : []));

/** For every point, the points joined to it. */
export function adjacencyOf({ points, edges }: LineGraph): number[][] {
	const adjacency: number[][] = points.map(() => []);
	for (const [a, b] of edges) {
		adjacency[a]?.push(b);
		adjacency[b]?.push(a);
	}
	return adjacency;
}

/** Index of the point in the same block as `p`, or -1. */
export const pointAt = (points: Point[], p: Point) =>
	points.findIndex(([x, z]) => x === p[0] && z === p[1]);

/** The graph of a line's paths: points in the same block become one point. */
export function graphFromPaths(paths: Point[][]): LineGraph {
	const points: Point[] = [];
	const index = new Map<string, number>();
	const edges: Edge[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		let prev = -1;
		for (const p of path) {
			const key = blockKey(p);
			let i = index.get(key);
			if (i === undefined) {
				i = points.length;
				index.set(key, i);
				points.push([p[0], p[1]]);
			}
			if (prev >= 0 && prev !== i && !seen.has(edgeKey(prev, i))) {
				seen.add(edgeKey(prev, i));
				edges.push([prev, i]);
			}
			prev = i;
		}
	}
	return { points, edges };
}

type Step = { edge: number; to: number };

/**
 * The fewest paths that run along every joint once: one for each pair of ends and forks with an
 * odd number of joints, or one closed path for a part that has none. Paths follow the joints in
 * the order they were made, so a plain path or loop comes back as it went in, and a branch added
 * to a path is a path of its own. Points without joints are left out.
 */
export function pathsFromGraph({ points, edges }: LineGraph): Point[][] {
	const adjacency: Step[][] = points.map(() => []);
	for (const [i, [a, b]] of edges.entries()) {
		adjacency[a]?.push({ edge: i, to: b });
		adjacency[b]?.push({ edge: i, to: a });
	}
	const used = new Array<boolean>(edges.length).fill(false);
	/** Joints of each point not walked yet. */
	const left = adjacency.map((steps) => steps.length);
	const walk = (start: number): number[] => {
		const trail = [start];
		let at = start;
		for (;;) {
			const step = adjacency[at]?.find((s) => !used[s.edge]);
			if (!step) return trail;
			used[step.edge] = true;
			left[at] = (left[at] as number) - 1;
			left[step.to] = (left[step.to] as number) - 1;
			at = step.to;
			trail.push(at);
		}
	};
	const first = (test: (n: number) => boolean) => left.findIndex(test);

	// A walk from a point with an odd number of joints left ends at another one; starting at ends
	// before forks keeps a line's main path in one piece.
	const trails: number[][] = [];
	for (;;) {
		let start = first((n) => n === 1);
		if (start < 0) start = first((n) => n % 2 === 1);
		if (start < 0) break;
		trails.push(walk(start));
	}
	// What is left are loops. One that touches a path is walked from there and spliced into it.
	for (;;) {
		let spliced = false;
		for (const trail of trails) {
			const k = trail.findIndex((i) => (left[i] as number) > 0);
			if (k < 0) continue;
			trail.splice(k, 1, ...walk(trail[k] as number));
			spliced = true;
			break;
		}
		if (spliced) continue;
		const start = first((n) => n > 0);
		if (start < 0) break;
		trails.push(walk(start));
	}
	return trails.map((t) => t.map((i) => points[i] as Point));
}

/** Drops the points in `remove` and renumbers the rest; `map` gives each old index its new one (-1 when gone). */
function without(
	g: LineGraph,
	remove: Set<number>,
): LineGraph & { map: number[] } {
	const map: number[] = [];
	const points: Point[] = [];
	g.points.forEach((p, i) => {
		map.push(remove.has(i) ? -1 : points.length);
		if (!remove.has(i)) points.push(p);
	});
	const edges: Edge[] = [];
	const seen = new Set<string>();
	for (const [a, b] of g.edges) {
		const na = map[a] as number;
		const nb = map[b] as number;
		if (na < 0 || nb < 0 || na === nb || seen.has(edgeKey(na, nb))) continue;
		seen.add(edgeKey(na, nb));
		edges.push([na, nb]);
	}
	return { points, edges, map };
}

/**
 * Removes point `i`. A point in the middle of a path is taken out of it, joining its two
 * neighbours; at a fork the branches come apart, and ends left without any joint go too.
 */
export function removeVertex(
	g: LineGraph,
	i: number,
): LineGraph & { map: number[] } {
	const around = neighbours(g.edges, i);
	const edges = g.edges.filter(([a, b]) => a !== i && b !== i);
	const [a, b] = around;
	if (around.length === 2 && a !== undefined && b !== undefined) {
		if (!hasEdge(edges, a, b)) edges.push([a, b]);
	}
	const remove = new Set([i]);
	if (around.length >= 3)
		for (const n of around)
			if (neighbours(edges, n).length === 0) remove.add(n);
	return without({ points: g.points, edges }, remove);
}

/** Point `from` becomes part of point `into`: its joints move there and it goes. */
export function mergeVertex(
	g: LineGraph,
	from: number,
	into: number,
): LineGraph & { map: number[] } {
	const edges = g.edges.map(
		([a, b]): Edge => [a === from ? into : a, b === from ? into : b],
	);
	return without({ points: g.points, edges }, new Set([from]));
}

/** Drops the points that are not joined to anything. */
export function dropLoose(g: LineGraph): LineGraph & { map: number[] } {
	const joined = new Set(g.edges.flat());
	return without(
		g,
		new Set(g.points.map((_, i) => i).filter((i) => !joined.has(i))),
	);
}

/**
 * The points of a line that is one closed loop and nothing else, in order from the first point
 * (which is not repeated at the end); null for any other line.
 */
export function loopOf(g: LineGraph): Point[] | null {
	const n = g.points.length;
	if (n < 3 || g.edges.length !== n) return null;
	const adjacency = adjacencyOf(g);
	if (adjacency.some((a) => a.length !== 2)) return null;
	const order = [0];
	let prev = -1;
	let at = 0;
	for (;;) {
		const [a, b] = adjacency[at] as [number, number];
		const next = a !== prev ? a : b;
		if (next === 0) break;
		order.push(next);
		prev = at;
		at = next;
		if (order.length > n) return null;
	}
	return order.length === n ? order.map((i) => g.points[i] as Point) : null;
}

/**
 * The points of a line that is a single path without branches or loops, from one end to the
 * other; null for any other line.
 */
export function simplePath(g: LineGraph): Point[] | null {
	const n = g.points.length;
	if (n < 2 || g.edges.length !== n - 1) return null;
	const adjacency = adjacencyOf(g);
	const start = adjacency.findIndex((a) => a.length === 1);
	if (start < 0) return null;
	const order = [start];
	let prev = -1;
	let at = start;
	for (;;) {
		const next = (adjacency[at] as number[]).find((i) => i !== prev);
		if (next === undefined) break;
		order.push(next);
		prev = at;
		at = next;
		if (order.length > n) return null;
	}
	return order.length === n ? order.map((i) => g.points[i] as Point) : null;
}

/** Total length of all joints, in blocks. */
export function lineLength({ points, edges }: LineGraph): number {
	let total = 0;
	for (const [a, b] of edges) {
		const p = points[a] as Point;
		const q = points[b] as Point;
		total += Math.hypot(q[0] - p[0], q[1] - p[1]);
	}
	return total;
}

/** A line's geometry as the API takes it: one path on its own, several as a list. */
export const lineGeometry = (paths: Point[][]): Point[] | Point[][] =>
	paths.length === 1 ? (paths[0] as Point[]) : paths;

import type { Point } from "@aomc/shared/features";
import { graphFromPaths } from "../tools/lineGraph";
import { type Bounds, boundsOf, type Pt } from "./geometry";

/** One piece of a curve: control points and the end, after the start of the piece. */
export type Bezier = [c1: Pt, c2: Pt, end: Pt];

/** A smooth curve through some points. A closed one ends where it starts and has no corner there. */
export type Stroke = {
	start: Pt;
	beziers: Bezier[];
	closed: boolean;
	/** The curve as short straight pieces, for hit tests and measuring; from `start` to the end. */
	samples: Pt[];
	/** Where in `samples` each piece of `beziers` ends. */
	ends: number[];
};

export type SmoothShape = { strokes: Stroke[]; bounds: Bounds };

/** Knot spacing exponent of the centripetal Catmull-Rom curve: no overshoot, no loops at sharp turns. */
const ALPHA = 0.5;
const MIN_STEPS = 6;
const MAX_STEPS = 48;
/** About this many blocks per straight piece when a curve is sampled. */
const BLOCKS_PER_STEP = 8;

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * The points of a line split into runs that are smoothed one by one. A run ends at an end of the
 * line and at every point where other than two segments meet, so forks are corners and each
 * branch is its own curve; a loop without a fork is one closed run. How the line was cut into
 * paths when it was saved makes no difference.
 */
export function chainsOf(
	paths: readonly (readonly Pt[])[],
): { points: Pt[]; closed: boolean }[] {
	const g = graphFromPaths(paths as Point[][]);
	const adjacency: { edge: number; to: number }[][] = g.points.map(() => []);
	for (const [i, [a, b]] of g.edges.entries()) {
		adjacency[a]?.push({ edge: i, to: b });
		adjacency[b]?.push({ edge: i, to: a });
	}
	const degree = adjacency.map((a) => a.length);
	const used = new Array<boolean>(g.edges.length).fill(false);
	const out: { points: Pt[]; closed: boolean }[] = [];

	const walk = (start: number, first: { edge: number; to: number }) => {
		const points: Pt[] = [g.points[start] as Pt];
		let step = first;
		for (;;) {
			used[step.edge] = true;
			points.push(g.points[step.to] as Pt);
			if (degree[step.to] !== 2 || step.to === start) {
				return { end: step.to, points };
			}
			const next = (adjacency[step.to] as (typeof adjacency)[0]).find(
				(s) => !used[s.edge],
			);
			if (!next) return { end: step.to, points };
			step = next;
		}
	};

	for (let v = 0; v < g.points.length; v++) {
		if (degree[v] === 2) continue;
		for (const step of adjacency[v] as (typeof adjacency)[0]) {
			if (used[step.edge]) continue;
			out.push({ points: walk(v, step).points, closed: false });
		}
	}
	// What is left has only points with two segments: loops.
	for (let v = 0; v < g.points.length; v++) {
		const step = (adjacency[v] as (typeof adjacency)[0]).find(
			(s) => !used[s.edge],
		);
		if (!step) continue;
		const { points } = walk(v, step);
		points.pop();
		out.push({ points, closed: true });
	}
	return out;
}

/** The pieces of the Catmull-Rom curve through `pts`, as cubic Béziers. */
function toBeziers(pts: readonly Pt[], closed: boolean): Bezier[] {
	const n = pts.length;
	const at = (i: number): Pt => {
		if (closed) return pts[((i % n) + n) % n] as Pt;
		if (i < 0) {
			const [a, b] = [pts[0] as Pt, pts[1] as Pt];
			return [2 * a[0] - b[0], 2 * a[1] - b[1]];
		}
		if (i >= n) {
			const [a, b] = [pts[n - 1] as Pt, pts[n - 2] as Pt];
			return [2 * a[0] - b[0], 2 * a[1] - b[1]];
		}
		return pts[i] as Pt;
	};
	const knot = (a: Pt, b: Pt) => Math.max(dist(a, b) ** ALPHA, 1e-3);
	const out: Bezier[] = [];
	const count = closed ? n : n - 1;
	for (let i = 0; i < count; i++) {
		const p0 = at(i - 1);
		const p1 = at(i);
		const p2 = at(i + 1);
		const p3 = at(i + 2);
		const d1 = knot(p0, p1);
		const d2 = knot(p1, p2);
		const d3 = knot(p2, p3);
		const tangent = (k: 0 | 1) => {
			const t1 =
				(p1[k] - p0[k]) / d1 -
				(p2[k] - p0[k]) / (d1 + d2) +
				(p2[k] - p1[k]) / d2;
			const t2 =
				(p2[k] - p1[k]) / d2 -
				(p3[k] - p1[k]) / (d2 + d3) +
				(p3[k] - p2[k]) / d3;
			return [d2 * t1, d2 * t2] as const;
		};
		const [x1, x2] = tangent(0);
		const [z1, z2] = tangent(1);
		out.push([
			[p1[0] + x1 / 3, p1[1] + z1 / 3],
			[p2[0] - x2 / 3, p2[1] - z2 / 3],
			p2,
		]);
	}
	return out;
}

function sample(
	start: Pt,
	beziers: Bezier[],
): { samples: Pt[]; ends: number[] } {
	const out: Pt[] = [start];
	const ends: number[] = [];
	let from = start;
	for (const [c1, c2, end] of beziers) {
		const steps = Math.min(
			MAX_STEPS,
			Math.max(MIN_STEPS, Math.ceil(dist(from, end) / BLOCKS_PER_STEP)),
		);
		for (let k = 1; k <= steps; k++) {
			const t = k / steps;
			const u = 1 - t;
			const a = u * u * u;
			const b = 3 * u * u * t;
			const c = 3 * u * t * t;
			const d = t * t * t;
			out.push(
				k === steps
					? end
					: [
							a * from[0] + b * c1[0] + c * c2[0] + d * end[0],
							a * from[1] + b * c1[1] + c * c2[1] + d * end[1],
						],
			);
		}
		from = end;
		ends.push(out.length - 1);
	}
	return { samples: out, ends };
}

function strokeOf(points: readonly Pt[], closed: boolean): Stroke {
	const start = points[0] as Pt;
	const beziers = toBeziers(points, closed);
	return { start, beziers, closed, ...sample(start, beziers) };
}

/**
 * The smooth version of a line (its paths, which may branch and loop) or of an area (its one
 * outline, closed). The curves go through every point.
 */
export function smoothShape(
	kind: "line" | "polygon",
	paths: readonly (readonly Pt[])[],
): SmoothShape {
	const strokes: Stroke[] =
		kind === "polygon"
			? [strokeOf(paths[0] ?? [], true)]
			: chainsOf(paths).map((c) => strokeOf(c.points, c.closed));
	const all = strokes.flatMap((s) => s.samples);
	return { strokes, bounds: boundsOf(all) };
}

/** Length of a polyline in blocks. */
export function polylineLength(points: readonly Pt[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++)
		total += dist(points[i - 1] as Pt, points[i] as Pt);
	return total;
}

/** Area enclosed by a polygon (shoelace formula), in square blocks. */
export function polylineArea(points: readonly Pt[]): number {
	let sum = 0;
	for (let i = 0; i < points.length; i++) {
		const [x1, z1] = points[i] as Pt;
		const [x2, z2] = points[(i + 1) % points.length] as Pt;
		sum += x1 * z2 - x2 * z1;
	}
	return Math.abs(sum) / 2;
}

/** A key for the segment between two points, the same whichever way round they are given. */
export const segmentKey = (a: Pt, b: Pt) =>
	a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])
		? `${a[0]},${a[1]}|${b[0]},${b[1]}`
		: `${b[0]},${b[1]}|${a[0]},${a[1]}`;

/** The middle of the curve between each pair of neighbouring points, by `segmentKey` of the pair. */
export function segmentMids(shape: SmoothShape): Map<string, Pt> {
	const out = new Map<string, Pt>();
	for (const stroke of shape.strokes) {
		let from = stroke.start;
		for (const [c1, c2, end] of stroke.beziers) {
			// A cubic Bézier at t = 1/2.
			out.set(segmentKey(from, end), [
				(from[0] + 3 * c1[0] + 3 * c2[0] + end[0]) / 8,
				(from[1] + 3 * c1[1] + 3 * c2[1] + end[1]) / 8,
			]);
			from = end;
		}
	}
	return out;
}

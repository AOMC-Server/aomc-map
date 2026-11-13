import { arcLengthAt, type Pt } from "./geometry";
import { type Bezier, chainsOf, type SmoothShape } from "./smooth";

/**
 * A stretch of a line or outline that is drawn (and dashed) in one go: from one end of a line or
 * fork to the next, or all the way round a loop. Piece `j` goes from `vertices[j]` to `vertices[j + 1]`,
 * straight or as a curve; a loop's last vertex is its first.
 */
export type DashRun = {
	vertices: Pt[];
	/** null: a straight piece. */
	pieces: (Bezier | null)[];
	closed: boolean;
	/** How far along the run (in blocks) each vertex is. */
	at: number[];
	length: number;
	/** The run as short straight pieces, for measuring and hit-testing. */
	samples: Pt[];
};

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function lengths(points: readonly Pt[]): number[] {
	const out = [0];
	for (let i = 1; i < points.length; i++)
		out.push(
			(out[i - 1] as number) + dist(points[i - 1] as Pt, points[i] as Pt),
		);
	return out;
}

function straightRun(points: readonly Pt[], closed: boolean): DashRun {
	const vertices = closed ? [...points, points[0] as Pt] : [...points];
	const at = lengths(vertices);
	return {
		vertices,
		pieces: vertices.slice(1).map(() => null),
		closed,
		at,
		length: at.at(-1) ?? 0,
		samples: vertices,
	};
}

/** The runs of a line or area, drawn straight or as the curves of `smooth`. */
export function dashRuns(
	type: "line" | "polygon",
	paths: readonly Pt[][],
	smooth: SmoothShape | null,
): DashRun[] {
	if (smooth)
		return smooth.strokes.map((s) => {
			const along = lengths(s.samples);
			const at = [0, ...s.ends.map((e) => along[e] ?? 0)];
			return {
				vertices: [s.start, ...s.beziers.map((b) => b[2])],
				pieces: s.beziers,
				closed: s.closed,
				at,
				length: along.at(-1) ?? 0,
				samples: s.samples,
			};
		});
	if (type === "polygon") return paths.map((ring) => straightRun(ring, true));
	return chainsOf(paths).map((c) => straightRun(c.points, c.closed));
}

/**
 * Where a run's dashes are. They keep their size on screen, so as the map is zoomed a point `d`
 * blocks along the run moves `d` times the change in scale along it, and the dashes there slide.
 * `offset` (canvas `lineDashOffset`) is moved to undo that at the point of the run nearest to
 * where the zoom is centred, so the dashes there stay still.
 *
 * A loop starts and ends its dashes at `seam`, a vertex. Its two sides do not line up there, and
 * zooming near it would make one side stand still and the other slide by the whole loop. So the
 * seam is moved to the far side of the loop from the zoom, but only at a moment when its dashes
 * happen to line up (its length on screen is a whole number of dashes), when moving it changes
 * nothing that can be seen. `cycles` is how many whole dashes fit around it, to tell when.
 */
export type DashState = { offset: number; seam: number; cycles: number | null };

export const newDashState = (): DashState => ({
	offset: 0,
	seam: 0,
	cycles: null,
});

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** A zoom since the last frame: the point (in blocks) that stayed still, and the scale before. */
export type ZoomStep = { x: number; z: number; from: number };

/** Updates `state` for a frame drawn at `scale` px per block, with `period` px per dash and gap. */
export function stepDashes(
	run: DashRun,
	state: DashState,
	scale: number,
	period: number,
	step: ZoomStep | null,
): DashState {
	let { offset, seam } = state;
	// The shape may have been edited since.
	if (seam >= run.pieces.length) seam = 0;
	const len = run.length;
	const cycles = run.closed ? Math.floor((len * scale) / period) : null;
	if (step && len > 0) {
		const along = arcLengthAt(step.x, step.z, run.samples);
		const fromSeam = run.closed ? mod(along - (run.at[seam] ?? 0), len) : along;
		offset += fromSeam * (step.from - scale);
		if (run.closed && state.cycles !== null && cycles !== state.cycles) {
			const best = nearestVertex(run, along + len / 2);
			// Starting at the new seam keeps every dash where it was on one side of it; the
			// other side moves by the little the dashes are out of line. That must not be the
			// side the zoom is centred in, where everything stands still.
			const moved = mod((run.at[best] ?? 0) - (run.at[seam] ?? 0), len);
			offset += (fromSeam < moved ? moved - len : moved) * scale;
			seam = best;
		}
	}
	return { offset: mod(offset, period), seam, cycles };
}

/** The vertex of a loop nearest to `d` blocks along it. */
function nearestVertex(run: DashRun, d: number): number {
	const len = run.length;
	let best = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let j = 0; j < run.pieces.length; j++) {
		const off = mod((run.at[j] ?? 0) - d, len);
		const dist = Math.min(off, len - off);
		if (dist < bestDist) {
			bestDist = dist;
			best = j;
		}
	}
	return best;
}

/** Adds a run to the current canvas path, starting (if it is a loop) at vertex `seam`. */
export function traceRun(
	ctx: CanvasRenderingContext2D,
	run: DashRun,
	seam: number,
	project: (x: number, z: number) => { x: number; y: number },
) {
	const k = run.pieces.length;
	const start = run.closed ? seam : 0;
	const first = project(...(run.vertices[start] as [number, number]));
	ctx.moveTo(first.x, first.y);
	let lastX = first.x;
	let lastY = first.y;
	for (let q = 0; q < k; q++) {
		const j = (start + q) % k;
		const piece = run.pieces[j];
		const end = run.vertices[j + 1] as Pt;
		const e = project(end[0], end[1]);
		if (piece) {
			const a = project(piece[0][0], piece[0][1]);
			const b = project(piece[1][0], piece[1][1]);
			ctx.bezierCurveTo(a.x, a.y, b.x, b.y, e.x, e.y);
		} else {
			// Skip vertices that fall on the same pixel; huge shapes stay cheap when zoomed out.
			if (q < k - 1 && Math.abs(e.x - lastX) + Math.abs(e.y - lastY) < 1.5)
				continue;
			ctx.lineTo(e.x, e.y);
		}
		lastX = e.x;
		lastY = e.y;
	}
	if (run.closed) ctx.closePath();
}

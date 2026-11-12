import type { FeatureType, Point } from "@aomc/shared/features";
import { computed, signal } from "@preact/signals";
import {
	type DragSession,
	isInteractiveTarget,
	isUiKeyTarget,
} from "../map/input";
import type { MapView } from "../map/MapView";
import { blockAt, blockCenter, nearestHandle, shiftHeld } from "./handles";
import {
	dropLoose,
	type Edge,
	graphFromPaths,
	hasEdge,
	type LineGraph,
	lineGeometry,
	loopOf,
	mergeVertex,
	neighbours,
	pathsFromGraph,
	pointAt,
	removeVertex,
	simplePath,
} from "./lineGraph";
import {
	midpoint,
	samePoint,
	segmentIndices,
	snapToLine,
	type Point as XZ,
} from "./measureMath";
import {
	handleSquare,
	outlinedPath,
	outlinedPaths,
	plusHandle,
} from "./overlay";

/**
 * Placing and editing a pin, line or area on the map: the engine behind the feature editor and
 * the measure tool, each with an editor of its own (see `createShapeEditor`).
 *
 * Click adds a vertex (Shift snaps it to a straight line), dragging a vertex moves it, dragging
 * the "+" on a segment inserts one, Enter or Esc finishes placing, Backspace or Delete removes
 * the selected vertex (or the last one), and so does a right click on a vertex. A pin is a
 * single vertex. An area is drawn in order and finished by clicking its first vertex.
 *
 * A line is a set of vertices and the segments joining them, so it can branch and close into
 * loops. New vertices are joined to the selected one: clicking a vertex of a finished line
 * selects it and goes on drawing from there (from a vertex in the middle, that is a branch).
 * Clicking the selected vertex again finishes, and clicking another vertex joins the two, which
 * closes a loop. A vertex dragged onto another merges with it.
 */
export type DrawState = {
	type: FeatureType;
	points: Point[];
	/** Lines only: the pairs of points that are joined. An area joins its points in order. */
	edges: Edge[];
	/** The picked vertex: a line goes on from it, and Delete removes it. */
	selected: number | null;
	/** "draw": clicks add vertices. "placed": geometry is complete; dragging edits it. */
	mode: "draw" | "placed";
};

export const minPoints = (type: FeatureType) =>
	type === "pin" ? 1 : type === "line" ? 2 : 3;

/** Number of different blocks among the points. */
const distinctCount = (points: Point[]) =>
	new Set(points.map(([x, z]) => `${x},${z}`)).size;

/** Whether the geometry is complete enough to save. */
export function drawReady(d: DrawState): boolean {
	if (d.type === "line") return d.edges.length > 0;
	return distinctCount(d.points) >= minPoints(d.type);
}

/** The geometry to save, in the form the API takes. */
export function drawnGeometry(d: DrawState): Point | Point[] | Point[][] {
	if (d.type === "pin") return d.points[0] as Point;
	if (d.type === "polygon") return d.points;
	return lineGeometry(pathsFromGraph(d));
}

/** The vertex a line draws on from when none is selected: its newest end. */
function lineTip(g: LineGraph): number | null {
	for (let i = g.points.length - 1; i >= 0; i--)
		if (neighbours(g.edges, i).length <= 1) return i;
	return g.points.length > 0 ? g.points.length - 1 : null;
}

/**
 * What a click on a vertex does: "finish" the shape, "join" it to the selected vertex (which
 * finishes too), or nothing special ("move": it is there to be dragged or selected).
 */
export type VertexAction = "finish" | "join" | "move";

export function vertexAction(d: DrawState, vertex: number): VertexAction {
	if (d.mode === "draw" && d.type === "line" && d.selected !== null) {
		if (vertex === d.selected) return drawReady(d) ? "finish" : "move";
		return hasEdge(d.edges, d.selected, vertex) ? "finish" : "join";
	}
	if (
		d.mode === "draw" &&
		d.type === "polygon" &&
		vertex === 0 &&
		d.points.length >= 3
	)
		return "finish";
	return "move";
}

export type ShapeStyle = {
	/** Colour of the shape and of the line to the pointer. */
	line: string;
	/** Colour of the first vertex when it is marked. */
	first: string;
	/** The first vertex of a line is marked too (areas always mark theirs). */
	markFirst: boolean;
	/** A line that is one closed loop is shaded like an area. */
	fillLoops: boolean;
};

export type ShapeOptions = {
	style: ShapeStyle;
	/** Whether this editor takes the pointer and keys now; others may share them. */
	active?: () => boolean;
	/** Whether the pointer says where the next point goes (touch screens use a crosshair instead). */
	pointerAims?: () => boolean;
	/** Esc on a shape that is only being looked at clears it, instead of leaving it. */
	escapeClears?: boolean;
};

/** The shape as it would be if the pointer were clicked now: the segment to the pointer included. */
export type Aimed = LineGraph & { preview: boolean };

const HANDLE = 6;
const MID_RADIUS = 9;
/** Segments shorter than this on screen get no "+" handle; it would sit on top of the vertices. */
const MIN_MID_SEGMENT_PX = 40;
/** A press on a vertex only drags once the pointer has moved this far; a smaller move is a click. */
const DRAG_START_PX = 5;

const ACCENT = "#ffe866";

// The geometry uses [x, z] pairs; the shared tool code uses { x, z }.
const xz = ([x, z]: Point): XZ => ({ x, z });
const pair = (p: XZ): Point => [p.x, p.z];

const toBlock = (map: MapView, sx: number, sy: number): Point =>
	pair(blockAt(map, sx, sy));
const center = (map: MapView, p: Point) => blockCenter(map, xz(p));

/** `p`, or with Shift held the nearest block on a straight line from `from`. */
const snapped = (from: Point | undefined, p: Point): Point =>
	shiftHeld.value && from ? pair(snapToLine(xz(from), xz(p))) : p;

/** Where the "+" of a segment is on screen, or null when the segment is too short for one. */
function midHandle(map: MapView, a: Point, b: Point) {
	const sa = center(map, a);
	const sb = center(map, b);
	if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < MIN_MID_SEGMENT_PX) return null;
	return blockCenter(map, midpoint(xz(a), xz(b)));
}

/** The vertex a new one is joined to: the selected one of a line, the last one of an area. */
function anchorOf(d: DrawState): Point | undefined {
	if (d.type === "line")
		return d.selected === null ? undefined : d.points[d.selected];
	return d.points.at(-1);
}

/** The segments as pairs of vertex indices. An area is only closed once it is placed. */
function segmentsOf(d: DrawState): [number, number][] {
	if (d.type === "line") return d.edges;
	if (d.type === "pin") return [];
	return segmentIndices(d.points.length, d.mode === "placed");
}

/** The segment whose "+" is at the screen position, if any. */
function plusAt(
	map: MapView,
	d: DrawState,
	sx: number,
	sy: number,
): [number, number] | null {
	for (const segment of segmentsOf(d)) {
		const mid = midHandle(
			map,
			d.points[segment[0]] as Point,
			d.points[segment[1]] as Point,
		);
		if (mid && Math.hypot(mid.x - sx, mid.y - sy) <= MID_RADIUS) return segment;
	}
	return null;
}

export function createShapeEditor(opts: ShapeOptions) {
	const active = opts.active ?? (() => true);
	const pointerAims = opts.pointerAims ?? (() => true);
	const style = opts.style;

	const state = signal<DrawState | null>(null);
	/** The vertex being pointed at in a list beside the map; it is drawn larger on the map. */
	const focused = signal<number | null>(null);
	/** The block the pointer (or a crosshair) is on. */
	const hover = signal<Point | null>(null);
	/** The vertex within reach of the pointer, or -1. */
	const hoverVertex = signal(-1);

	let onCancel: (() => void) | null = null;

	const setHover = (p: Point | null) => {
		const old = hover.peek();
		if (!samePoint(p && xz(p), old && xz(old))) hover.value = p;
	};

	/** The shape with the segment a click at the pointer would add. */
	const aimed = computed<Aimed | null>(() => {
		const d = state.value;
		if (!d) return null;
		const plain: Aimed = {
			points: d.points,
			edges: d.type === "line" ? d.edges : [],
			preview: false,
		};
		if (d.type !== "line" || d.mode !== "draw" || d.selected === null)
			return plain;
		const from = d.points[d.selected];
		const h = hover.value;
		const target = hoverVertex.value;
		if (!from) return plain;
		const join = (to: number): Aimed =>
			to === d.selected || hasEdge(d.edges, d.selected as number, to)
				? plain
				: {
						points: d.points,
						edges: [...d.edges, [d.selected as number, to]],
						preview: true,
					};
		if (target >= 0) return join(target);
		if (!h) return plain;
		const aim = snapped(from, h);
		const existing = pointAt(d.points, aim);
		if (existing >= 0) return join(existing);
		return {
			points: [...d.points, aim],
			edges: [...d.edges, [d.selected, d.points.length]],
			preview: true,
		};
	});

	/** Starts placing a shape. `paths` is its geometry: one path for a pin or an area, any number for a line. */
	function start(type: FeatureType, paths: Point[][], cancel: () => void) {
		onCancel = cancel;
		const shape: LineGraph =
			type === "line"
				? graphFromPaths(paths)
				: { points: paths[0] ?? [], edges: [] };
		const d: DrawState = { type, ...shape, selected: null, mode: "draw" };
		if (drawReady(d)) d.mode = "placed";
		else if (type === "line") d.selected = lineTip(d);
		state.value = d;
	}

	/** Changes the kind of shape but keeps the points that still make sense (a line becomes an area, and back). */
	function setType(type: FeatureType) {
		const d = state.value;
		if (!d || d.type === type) return;
		let shape: LineGraph;
		if (type === "pin") shape = { points: d.points.slice(0, 1), edges: [] };
		else if (type === "line") {
			// A finished area becomes a loop around it.
			const closed = d.type === "polygon" && d.mode === "placed";
			const first = d.points[0];
			shape = graphFromPaths([
				closed && first ? [...d.points, first] : d.points,
			]);
		} else {
			// An area goes round the points in the order the line's paths visit them.
			const ordered =
				d.edges.length > 0 ? pathsFromGraph(d).flat() : [...d.points];
			const seen = new Set<string>();
			const points = ordered.filter((p) => {
				const key = `${p[0]},${p[1]}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			shape = { points, edges: [] };
		}
		const next: DrawState = { type, ...shape, selected: null, mode: "draw" };
		if ((d.mode === "placed" || type === "pin") && drawReady(next))
			next.mode = "placed";
		else if (type === "line") next.selected = lineTip(next);
		focused.value = null;
		state.value = next;
	}

	/** Moves a vertex. Without `settle` it stays where it is even on top of another one, as while dragging. */
	function setPoint(index: number, point: Point, settle = true) {
		const d = state.value;
		if (!d || index < 0 || index >= d.points.length) return;
		const points = [...d.points];
		points[index] = point;
		state.value = { ...d, points };
		if (settle) settlePoint(index);
	}

	/** A line's vertex that has been put in the block of another one becomes part of it. */
	function settlePoint(index: number) {
		const d = state.value;
		const p = d?.points[index];
		if (d?.type !== "line" || !p) return;
		const other = d.points.findIndex(
			(q, i) => i !== index && q[0] === p[0] && q[1] === p[1],
		);
		if (other < 0) return;
		const merged = mergeVertex(d, index, other);
		const selected =
			d.selected === index
				? (merged.map[other] as number)
				: d.selected === null
					? null
					: (merged.map[d.selected] as number);
		focused.value = null;
		state.value = {
			...d,
			points: merged.points,
			edges: merged.edges,
			selected,
		};
	}

	function removePoint(index: number) {
		const d = state.value;
		if (!d || index < 0 || index >= d.points.length) return;
		focused.value = null;
		hoverVertex.value = -1;
		if (d.type !== "line") {
			const points = d.points.filter((_, i) => i !== index);
			const selected =
				d.selected === null || d.selected === index
					? null
					: d.selected > index
						? d.selected - 1
						: d.selected;
			const next: DrawState = { ...d, points, selected, mode: "draw" };
			if (d.mode === "placed" && drawReady(next)) next.mode = "placed";
			state.value = next;
			return;
		}
		const around = neighbours(d.edges, index);
		const removed = removeVertex(d, index);
		const remap = (i: number | undefined) => {
			const n = i === undefined ? -1 : (removed.map[i] as number);
			return n >= 0 ? n : null;
		};
		// Taking back the vertex being drawn from goes back to the one before it.
		let selected =
			d.selected !== index
				? remap(d.selected ?? undefined)
				: d.mode === "draw" && around.length === 1
					? remap(around[0])
					: null;
		const next: DrawState = {
			...d,
			points: removed.points,
			edges: removed.edges,
			selected,
			mode: "draw",
		};
		if (drawReady(next) && (d.mode === "placed" || selected === null))
			next.mode = "placed";
		else if (selected === null) selected = lineTip(next);
		state.value = { ...next, selected };
	}

	/** Removes the selected vertex, or the last one when none is selected. */
	function undoPoint() {
		const d = state.value;
		if (!d || d.points.length === 0) return;
		if (d.selected !== null) {
			removePoint(d.selected);
			return;
		}
		if (d.type === "line") {
			removePoint(d.points.length - 1);
			return;
		}
		state.value = { ...d, points: d.points.slice(0, -1), mode: "draw" };
	}

	/** Selects a vertex (null: none) without drawing on from it. */
	function selectPoint(index: number | null) {
		const d = state.value;
		if (!d || (index !== null && (index < 0 || index >= d.points.length)))
			return;
		state.value = { ...d, selected: index };
	}

	function resume() {
		const d = state.value;
		if (!d) return;
		if (d.type === "pin")
			state.value = { ...d, points: [], selected: null, mode: "draw" };
		else if (d.type === "line")
			state.value = { ...d, selected: d.selected ?? lineTip(d), mode: "draw" };
		else state.value = { ...d, selected: null, mode: "draw" };
	}

	function finish(): boolean {
		const d = state.value;
		if (!d || !drawReady(d)) return false;
		if (d.type === "line") {
			// Vertices left without any segment have nothing to be part of.
			const { points, edges } = dropLoose(d);
			state.value = { ...d, points, edges, selected: null, mode: "placed" };
		} else state.value = { ...d, selected: null, mode: "placed" };
		return true;
	}

	/** The end of a plain path that is not the selected one, which a line being drawn can be closed on. */
	function closingEnd(): number | null {
		const d = state.value;
		if (d?.type !== "line" || d.mode !== "draw" || d.selected === null)
			return null;
		const path = simplePath(d);
		if (!path || path.length < 3) return null;
		const ends = [
			pointAt(d.points, path[0] as Point),
			pointAt(d.points, path.at(-1) as Point),
		];
		if (!ends.includes(d.selected)) return null;
		return ends[0] === d.selected ? (ends[1] as number) : (ends[0] as number);
	}

	/** Joins the end being drawn from back to the other end of the path, and finishes: a loop. */
	function closeLine(): boolean {
		const d = state.value;
		const end = closingEnd();
		if (!d || d.selected === null || end === null) return false;
		state.value = { ...d, edges: [...d.edges, [d.selected, end]] };
		return finish();
	}

	/** Stops without telling anyone (the owner of the editor calls this when it closes). */
	function stop() {
		state.value = null;
		focused.value = null;
		hoverVertex.value = -1;
		onCancel = null;
	}

	function cancel() {
		const callback = onCancel;
		stop();
		callback?.();
	}

	/**
	 * Esc: stops drawing segments but keeps what is drawn, so that a line can then be branched from
	 * any of its vertices; a finished shape loses its selection (and, for editors that ask for it,
	 * then its points). With nothing drawn it closes the editor.
	 */
	function stopDrawing() {
		const d = state.value;
		if (!d) return;
		if (d.points.length === 0) {
			cancel();
			return;
		}
		if (d.mode === "draw" && d.type !== "pin" && finish()) return;
		if (d.selected !== null) {
			state.value = { ...d, selected: null };
			return;
		}
		if (opts.escapeClears) {
			const callback = onCancel;
			if (callback) start(d.type, [], callback);
		}
	}

	/** A click on vertex `index` (a press on it that did not drag). */
	function clickVertex(index: number) {
		const d = state.value;
		if (!d) return;
		if (d.type === "line") {
			if (d.mode === "placed" || d.selected === null) {
				state.value = { ...d, selected: index, mode: "draw" };
				return;
			}
			if (d.selected !== index && !hasEdge(d.edges, d.selected, index)) {
				// Joining two vertices; when the line already reaches the other one, that closes a loop.
				state.value = { ...d, edges: [...d.edges, [d.selected, index]] };
			}
			finish();
			return;
		}
		if (d.type !== "polygon") return;
		if (d.mode === "draw" && index === 0 && d.points.length >= 3) {
			finish();
			return;
		}
		state.value = { ...d, selected: d.selected === index ? null : index };
	}

	/** A click on the block `p` while placing: adds a vertex there, or uses the one that is there. */
	function place(p: Point) {
		const d = state.value;
		if (d?.mode !== "draw") return;
		if (d.type === "pin") {
			state.value = { ...d, points: [p], mode: "placed" };
			return;
		}
		const next = snapped(anchorOf(d), p);
		if (d.type === "line") {
			// A click in the block of a vertex is a click on that vertex.
			const existing = pointAt(d.points, next);
			if (existing >= 0) {
				clickVertex(existing);
				return;
			}
			const i = d.points.length;
			const edges: Edge[] =
				d.selected === null ? d.edges : [...d.edges, [d.selected, i]];
			state.value = {
				...d,
				points: [...d.points, next],
				edges,
				selected: i,
			};
			return;
		}
		const last = d.points.at(-1);
		// Another click in the block of the last vertex adds nothing.
		if (last && samePoint(xz(last), xz(next))) return;
		state.value = { ...d, points: [...d.points, next], selected: null };
	}

	/** Dragging vertex `index`. A press that does not move is a click on it. */
	function vertexSession(
		map: MapView,
		index: number,
		sx: number,
		sy: number,
		inserted: boolean,
	): DragSession {
		let dragging = false;
		return {
			move(mx, my) {
				if (!dragging) {
					if (Math.hypot(mx - sx, my - sy) < DRAG_START_PX) return;
					dragging = true;
					hoverVertex.value = -1;
				}
				const d = state.value;
				const current = d?.points[index];
				if (!d || !current) return;
				const raw = toBlock(map, mx, my);
				const neighbour =
					d.type === "line"
						? neighbours(d.edges, index)[0]
						: d.points[index - 1]
							? index - 1
							: index + 1;
				const next =
					d.type === "pin"
						? raw
						: snapped(
								neighbour === undefined ? undefined : d.points[neighbour],
								raw,
							);
				if (next[0] === current[0] && next[1] === current[1]) return;
				setPoint(index, next, false);
			},
			end() {
				if (dragging || inserted) settlePoint(index);
				else clickVertex(index);
			},
			cancel() {
				settlePoint(index);
			},
		};
	}

	/** Lets a vertex be dragged, or a new one be pulled out of the "+" on a segment. */
	function grab(map: MapView, sx: number, sy: number): DragSession | null {
		const d = state.value;
		if (!d || !active()) return null;

		const vertex = nearestHandle(map, d.points.map(xz), sx, sy);
		if (vertex >= 0) return vertexSession(map, vertex, sx, sy, false);

		const segment = plusAt(map, d, sx, sy);
		if (!segment) return null;
		const [a, b] = segment;
		const pa = d.points[a] as Point;
		const pb = d.points[b] as Point;
		const point = pair(midpoint(xz(pa), xz(pb)));
		if (d.type === "line") {
			// The new vertex splits the segment in two.
			const at = d.points.length;
			const edges = d.edges.filter(
				(e) => !((e[0] === a && e[1] === b) || (e[0] === b && e[1] === a)),
			);
			edges.push([a, at], [at, b]);
			state.value = { ...d, points: [...d.points, point], edges };
			return vertexSession(map, at, sx, sy, true);
		}
		// The closing segment of an area runs from the last vertex back to the first.
		const at = b === 0 ? d.points.length : b;
		const points = [...d.points];
		points.splice(at, 0, point);
		const selected =
			d.selected !== null && d.selected >= at ? d.selected + 1 : d.selected;
		state.value = { ...d, points, selected };
		return vertexSession(map, at, sx, sy, true);
	}

	/**
	 * The cursor for what a click or drag at the screen position would do: finish ("pointer"),
	 * join two vertices ("alias"), move a vertex ("grab"), pull a new one out of a "+" ("copy"),
	 * or add one or pan the map (the map's own crosshair). Null when not active.
	 */
	function cursor(map: MapView, sx: number, sy: number) {
		const d = state.value;
		if (!d || !active()) return null;
		const vertex = nearestHandle(map, d.points.map(xz), sx, sy);
		if (vertex >= 0) {
			const action = vertexAction(d, vertex);
			return action === "finish"
				? "pointer"
				: action === "join"
					? "alias"
					: "grab";
		}
		if (plusAt(map, d, sx, sy)) return "copy";
		return "crosshair";
	}

	/** A right click on a vertex removes it. Returns whether there was one. */
	function removeAt(map: MapView, sx: number, sy: number) {
		const d = state.value;
		if (!d || !active() || d.type === "pin") return false;
		const vertex = nearestHandle(map, d.points.map(xz), sx, sy);
		if (vertex < 0) return false;
		removePoint(vertex);
		return true;
	}

	/** Connects the editor to the map's clicks, pointer and keys. */
	function init(map: MapView) {
		map.on("move", (e) => {
			if (!active() || !pointerAims()) return;
			const d = state.value;
			const block = e ? toBlock(map, e.sx, e.sy) : null;
			const vertex =
				e && d ? nearestHandle(map, d.points.map(xz), e.sx, e.sy) : -1;
			if (vertex !== hoverVertex.peek()) hoverVertex.value = vertex;
			if (
				samePoint(block && xz(block), hover.peek() && xz(hover.peek() as Point))
			)
				return;
			setHover(block);
			if (d?.mode === "draw") map.invalidate();
		});
		map.on("click", (e) => {
			if (!active() || !pointerAims()) return;
			if (state.value?.mode !== "draw") return;
			place(toBlock(map, e.sx, e.sy));
		});

		window.addEventListener("keydown", (e) => {
			const d = state.value;
			if (!d || !active() || isUiKeyTarget(e.target)) return;
			if (e.key === "Enter") {
				// A focused button or link uses Enter itself.
				if (d.mode === "draw" && !isInteractiveTarget(e.target) && finish())
					e.preventDefault();
			} else if (e.key === "Escape") {
				stopDrawing();
				e.preventDefault();
			} else if (e.key === "Backspace" || e.key === "Delete") {
				undoPoint();
				e.preventDefault();
			}
		});
	}

	/** Overlay: the shape being placed, with "+" handles to add vertices. */
	function draw(ctx: CanvasRenderingContext2D, map: MapView) {
		const d = state.value;
		if (!d || d.points.length === 0) return;
		const pts = d.points.map((p) => center(map, p));
		const aim = aimed.value;
		ctx.save();
		ctx.lineJoin = "round";
		ctx.lineCap = "round";

		if (d.type === "polygon") {
			if (pts.length >= 3) {
				ctx.beginPath();
				for (const [i, p] of pts.entries()) {
					if (i === 0) ctx.moveTo(p.x, p.y);
					else ctx.lineTo(p.x, p.y);
				}
				ctx.closePath();
				ctx.fillStyle = "rgba(255, 232, 102, 0.16)";
				ctx.fill();
			}
			outlinedPath(ctx, pts, {
				color: style.line,
				closed: d.mode === "placed",
			});
		} else if (d.type === "line") {
			// A loop (also the one a click would close) is shaded like an area.
			const loop = style.fillLoops && aim ? loopOf(aim) : null;
			if (loop) {
				ctx.beginPath();
				for (const [i, p] of loop.entries()) {
					const s = center(map, p);
					if (i === 0) ctx.moveTo(s.x, s.y);
					else ctx.lineTo(s.x, s.y);
				}
				ctx.closePath();
				ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
				ctx.fill();
			}
			const segments = d.edges.map(([a, b]) => [
				pts[a] as { x: number; y: number },
				pts[b] as { x: number; y: number },
			]);
			outlinedPaths(ctx, segments, { color: style.line });
			if (aim?.preview) {
				const [a, b] = aim.edges.at(-1) as Edge;
				const from = center(map, aim.points[a] as Point);
				const to = center(map, aim.points[b] as Point);
				outlinedPath(ctx, [from, to], {
					color: style.line,
					width: 2,
					dashed: true,
				});
			}
		}

		const anchor = anchorOf(d);
		const h = hover.value;
		if (d.type === "polygon" && d.mode === "draw" && h && anchor) {
			const from = center(map, anchor);
			const to = center(map, snapped(anchor, h));
			const band = [from, to];
			if (pts.length >= 2) band.push(pts[0] as typeof from);
			outlinedPath(ctx, band, { color: style.line, width: 2, dashed: true });
		}

		for (const [a, b] of segmentsOf(d)) {
			const mid = midHandle(map, d.points[a] as Point, d.points[b] as Point);
			if (mid) plusHandle(ctx, mid.x, mid.y);
		}

		// The vertex a click would finish or join on is drawn larger, so it is clear what the click does.
		const target = hoverVertex.value;
		const clickTarget =
			target >= 0 &&
			target < d.points.length &&
			vertexAction(d, target) !== "move"
				? target
				: -1;
		pts.forEach((p, i) => {
			const big = i === focused.value || i === d.selected || i === clickTarget;
			const first =
				i === 0 &&
				(d.type === "polygon" || (style.markFirst && d.type === "line"));
			handleSquare(
				ctx,
				p.x,
				p.y,
				big ? HANDLE + 3 : HANDLE,
				big ? ACCENT : first ? style.first : "#fff",
			);
		});
		ctx.restore();
	}

	return {
		state,
		focused,
		hover,
		hoverVertex,
		aimed,
		setHover,
		start,
		setType,
		setPoint,
		removePoint,
		undoPoint,
		selectPoint,
		resume,
		finish,
		closeLine,
		canCloseLine: () => closingEnd() !== null,
		stop,
		stopDrawing,
		place,
		grab,
		cursor,
		removeAt,
		init,
		draw,
	};
}

export type ShapeEditor = ReturnType<typeof createShapeEditor>;

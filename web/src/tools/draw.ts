import type { FeatureType, Point } from "@aomc/shared/features";
import { signal } from "@preact/signals";
import {
	type DragSession,
	isInteractiveTarget,
	isUiKeyTarget,
} from "../map/input";
import type { MapView } from "../map/MapView";
import { blockAt, blockCenter, nearestHandle, shiftHeld } from "./handles";
import {
	midpoint,
	samePoint,
	segmentIndices,
	snapToLine,
	type Point as XZ,
} from "./measureMath";
import { handleSquare, outlinedPath, plusHandle } from "./overlay";

/**
 * Geometry placement for the feature editor.
 *
 * Click adds a vertex (Shift snaps it to a straight line), dragging a vertex moves it, dragging
 * the "+" on a segment inserts one, clicking the last vertex of a line or the first of an area
 * finishes it, Enter finishes placing, Esc cancels, Backspace removes the last vertex. A pin is a
 * single vertex.
 */
export type DrawState = {
	type: FeatureType;
	points: Point[];
	/** "draw": clicks add vertices. "placed": geometry is complete; only dragging edits it. */
	mode: "draw" | "placed";
};

export const drawing = signal<DrawState | null>(null);
/** The vertex being pointed at in the editor's list; it is drawn larger on the map. */
export const focusedPoint = signal<number | null>(null);

let onCancel: (() => void) | null = null;

export const minPoints = (type: FeatureType) =>
	type === "pin" ? 1 : type === "line" ? 2 : 3;

export function startDraw(
	type: FeatureType,
	points: Point[],
	cancel: () => void,
) {
	onCancel = cancel;
	drawing.value = {
		type,
		points,
		mode: points.length >= minPoints(type) ? "placed" : "draw",
	};
}

/** Changes the kind of feature but keeps the points that still make sense (a line becomes an area, and back). */
export function setDrawType(type: FeatureType) {
	const d = drawing.value;
	if (!d) return;
	const points = type === "pin" ? d.points.slice(0, 1) : d.points;
	const placed =
		(d.mode === "placed" || type === "pin") && points.length >= minPoints(type);
	drawing.value = { type, points, mode: placed ? "placed" : "draw" };
}

export function setPoint(index: number, point: Point) {
	const d = drawing.value;
	if (!d || index < 0 || index >= d.points.length) return;
	const points = [...d.points];
	points[index] = point;
	drawing.value = { ...d, points };
}

export function removePoint(index: number) {
	const d = drawing.value;
	if (!d || index < 0 || index >= d.points.length) return;
	const points = d.points.filter((_, i) => i !== index);
	const placed = d.mode === "placed" && points.length >= minPoints(d.type);
	focusedPoint.value = null;
	drawing.value = { ...d, points, mode: placed ? "placed" : "draw" };
}

export function resumeDraw() {
	const d = drawing.value;
	if (d && d.type !== "pin") drawing.value = { ...d, mode: "draw" };
	else if (d) drawing.value = { ...d, points: [], mode: "draw" };
}

/** Number of different blocks among the points. */
const distinctCount = (points: Point[]) =>
	new Set(points.map(([x, z]) => `${x},${z}`)).size;

export function finishDraw(): boolean {
	const d = drawing.value;
	if (!d || distinctCount(d.points) < minPoints(d.type)) return false;
	drawing.value = { ...d, mode: "placed" };
	return true;
}

export function undoPoint() {
	const d = drawing.value;
	if (!d || d.points.length === 0) return;
	drawing.value = { ...d, points: d.points.slice(0, -1), mode: "draw" };
}

/** Stops drawing without telling anyone (the editor calls this when it closes). */
export function stopDraw() {
	drawing.value = null;
	focusedPoint.value = null;
	onCancel = null;
}

function cancelDraw() {
	const cancel = onCancel;
	stopDraw();
	cancel?.();
}

const HANDLE = 6;
const MID_RADIUS = 9;
/** Segments shorter than this on screen get no "+" handle; it would sit on top of the vertices. */
const MIN_MID_SEGMENT_PX = 40;
/** A press on a vertex only drags once the pointer has moved this far; a smaller move is a click. */
const DRAG_START_PX = 5;

const LINE = "#ffe866";

// The geometry uses [x, z] pairs; the shared tool code uses { x, z }.
const xz = ([x, z]: Point): XZ => ({ x, z });
const pair = (p: XZ): Point => [p.x, p.z];

const toBlock = (map: MapView, sx: number, sy: number): Point =>
	pair(blockAt(map, sx, sy));
const center = (map: MapView, p: Point) => blockCenter(map, xz(p));

/** The block under the pointer, for the rubber band line while placing vertices. */
let hover: Point | null = null;

/** `p`, or with Shift held the nearest block on a straight line from `from`. */
const snapped = (from: Point | undefined, p: Point): Point =>
	shiftHeld.value && from ? pair(snapToLine(xz(from), xz(p))) : p;

export function initDrawTool(map: MapView) {
	map.on("move", (e) => {
		const block = e ? toBlock(map, e.sx, e.sy) : null;
		if (samePoint(block && xz(block), hover && xz(hover))) return;
		hover = block;
		if (drawing.value?.mode === "draw") map.invalidate();
	});
	map.on("click", (e) => {
		const d = drawing.value;
		if (d?.mode !== "draw") return;
		const p = toBlock(map, e.sx, e.sy);
		if (d.type === "pin") {
			drawing.value = { ...d, points: [p], mode: "placed" };
			return;
		}
		const next = snapped(d.points.at(-1), p);
		const last = d.points.at(-1);
		// Another click in the block of the last vertex adds nothing.
		if (last && samePoint(xz(last), xz(next))) return;
		drawing.value = { ...d, points: [...d.points, next] };
	});

	window.addEventListener("keydown", (e) => {
		const d = drawing.value;
		if (!d || isUiKeyTarget(e.target)) return;
		if (e.key === "Enter") {
			// A focused button or link uses Enter itself.
			if (d.mode === "draw" && !isInteractiveTarget(e.target) && finishDraw())
				e.preventDefault();
		} else if (e.key === "Escape") {
			cancelDraw();
			e.preventDefault();
		} else if (e.key === "Backspace" || e.key === "Delete") {
			undoPoint();
			e.preventDefault();
		}
	});
}

/** Dragging vertex `index`. A press that does not move is a click, which can finish the shape. */
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
			}
			const d = drawing.value;
			const current = d?.points[index];
			if (!d || !current) return;
			const raw = toBlock(map, mx, my);
			const next =
				d.type === "pin"
					? raw
					: snapped(d.points[index - 1] ?? d.points[index + 1], raw);
			if (next[0] === current[0] && next[1] === current[1]) return;
			setPoint(index, next);
		},
		end() {
			if (dragging || inserted) return;
			const d = drawing.value;
			if (d?.mode !== "draw") return;
			const n = d.points.length;
			if (
				(d.type === "polygon" && index === 0 && n >= 3) ||
				(d.type === "line" && index === n - 1 && n >= 2)
			)
				finishDraw();
		},
		cancel() {},
	};
}

/** Where the "+" of a segment is on screen, or null when the segment is too short for one. */
function midHandle(map: MapView, a: Point, b: Point) {
	const sa = center(map, a);
	const sb = center(map, b);
	if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < MIN_MID_SEGMENT_PX) return null;
	return blockCenter(map, midpoint(xz(a), xz(b)));
}

/** Lets a vertex be dragged, or a new one be pulled out of the "+" on a segment. */
export function grabDrawPoint(
	map: MapView,
	sx: number,
	sy: number,
): DragSession | null {
	const d = drawing.value;
	if (!d) return null;

	const vertex = nearestHandle(map, d.points.map(xz), sx, sy);
	if (vertex >= 0) return vertexSession(map, vertex, sx, sy, false);
	if (d.type === "pin") return null;

	const closed = d.type === "polygon" && d.mode === "placed";
	for (const [a, b] of segmentIndices(d.points.length, closed)) {
		const pa = d.points[a] as Point;
		const pb = d.points[b] as Point;
		const mid = midHandle(map, pa, pb);
		if (!mid || Math.hypot(mid.x - sx, mid.y - sy) > MID_RADIUS) continue;
		// The closing segment of an area runs from the last vertex back to the first.
		const at = b === 0 ? d.points.length : b;
		const points = [...d.points];
		points.splice(at, 0, pair(midpoint(xz(pa), xz(pb))));
		drawing.value = { ...d, points };
		return vertexSession(map, at, sx, sy, true);
	}
	return null;
}

/** Overlay: the geometry being placed, with "+" handles to add vertices. */
export function drawGeometry(ctx: CanvasRenderingContext2D, map: MapView) {
	const d = drawing.value;
	if (!d || d.points.length === 0) return;
	const pts = d.points.map((p) => center(map, p));
	ctx.save();
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	if (d.type !== "pin") {
		const closed = d.type === "polygon" && d.mode === "placed";
		if (d.type === "polygon" && pts.length >= 3) {
			ctx.beginPath();
			for (const [i, p] of pts.entries()) {
				if (i === 0) ctx.moveTo(p.x, p.y);
				else ctx.lineTo(p.x, p.y);
			}
			ctx.closePath();
			ctx.fillStyle = "rgba(255, 232, 102, 0.16)";
			ctx.fill();
		}
		outlinedPath(ctx, pts, { color: LINE, closed });

		if (d.mode === "draw" && hover) {
			const last = pts[pts.length - 1] as { x: number; y: number };
			const aim = center(map, snapped(d.points.at(-1), hover));
			const band = [last, aim];
			if (d.type === "polygon" && pts.length >= 2)
				band.push(pts[0] as typeof last);
			outlinedPath(ctx, band, { color: LINE, width: 2, dashed: true });
		}

		for (const [a, b] of segmentIndices(d.points.length, closed)) {
			const mid = midHandle(map, d.points[a] as Point, d.points[b] as Point);
			if (mid) plusHandle(ctx, mid.x, mid.y);
		}
	}

	pts.forEach((p, i) => {
		const focused = i === focusedPoint.value;
		const first = i === 0 && d.type !== "pin";
		handleSquare(
			ctx,
			p.x,
			p.y,
			focused ? HANDLE + 3 : HANDLE,
			focused ? LINE : first ? "#52a535" : "#fff",
		);
	});
	ctx.restore();
}

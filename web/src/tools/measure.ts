import { computed, signal } from "@preact/signals";
import type { DragSession } from "../map/input";
import type { MapView } from "../map/MapView";
import { activeTool } from "../state";
import { blockAt, blockCenter, nearestHandle, shiftHeld } from "./handles";
import {
	facing,
	type Point,
	polygonArea,
	samePoint,
	segmentIndices,
	snapToLine,
} from "./measureMath";
import { handleSquare, labelBox, outlinedPath } from "./overlay";

export type { Point };

/** The points placed so far (block coordinates), in order. */
export const measurePoints = signal<Point[]>([]);
/** The block under the cursor while measuring. */
export const measureHover = signal<Point | null>(null);
/**
 * How the measurement was finished: `line` by clicking its last point, `shape` by clicking its
 * first point, which joins the path back to the start. Null while points are still being placed.
 */
export const measureFinish = signal<"line" | "shape" | null>(null);
/** The placed point the pointer is over that a click would finish on (first or last), or -1. */
export const measureFinishTarget = signal(-1);

/** A press on a point only drags once the pointer has moved this far; a smaller move is a click. */
const DRAG_START_PX = 5;

/** Which placed point a click at this screen position would finish the measurement on, or -1. */
function finishTargetAt(map: MapView, sx: number, sy: number): number {
	const points = measurePoints.value;
	if (measureFinish.value || points.length < 2) return -1;
	const index = nearestHandle(map, points, sx, sy);
	if (index === 0 && points.length >= 3) return 0;
	if (index === points.length - 1) return index;
	return -1;
}

/** `p`, or with Shift held the nearest point on a straight line from the last placed one. */
function snapped(p: Point): Point {
	const last = measurePoints.value.at(-1);
	return shiftHeld.value && last ? snapToLine(last, p) : p;
}

/** Where a click would put the next point; on the first point when it would close the shape. */
const measureAim = computed(() => {
	if (measureFinish.value) return null;
	const target = measureFinishTarget.value;
	if (target === 0) return measurePoints.value[0] ?? null;
	const hover = measureHover.value;
	return hover && measurePoints.value.length > 0 ? snapped(hover) : hover;
});

export type MeasureStats = {
	points: Point[];
	segments: number[];
	/** Length of the whole path. */
	total: number;
	/** From the first point to the last, as the crow flies. */
	straight: number;
	dx: number;
	dz: number;
	facing: { name: string; yaw: number } | null;
	/** True when the last point is the cursor rather than a placed point. */
	preview: boolean;
	/** The path is a closed shape: its last segment runs back to the first point. */
	closed: boolean;
	/** Area enclosed by a closed shape (or by the one the cursor would close), in square blocks. */
	area: number | null;
};

/** Numbers for the measure card, including the segment to the cursor while aiming. */
export const measureStats = computed<MeasureStats | null>(() => {
	const placed = measurePoints.value;
	if (placed.length === 0) return null;
	const closed = measureFinish.value === "shape" && placed.length >= 3;
	const aim = measureAim.value;
	const last = placed.at(-1) as Point;
	const preview = aim !== null && (aim.x !== last.x || aim.z !== last.z);
	const points = preview ? [...placed, aim] : placed;
	const closing = !closed && preview && measureFinishTarget.value === 0;
	const first = points[0] as Point;
	const end = points.at(-1) as Point;
	const dx = end.x - first.x;
	const dz = end.z - first.z;
	const segments = segmentIndices(points.length, closed).map(([a, b]) => {
		const p = points[a] as Point;
		const q = points[b] as Point;
		return Math.hypot(q.x - p.x, q.z - p.z);
	});
	return {
		points,
		segments,
		total: segments.reduce((sum, length) => sum + length, 0),
		straight: Math.hypot(dx, dz),
		dx,
		dz,
		facing: dx === 0 && dz === 0 ? null : facing(dx, dz),
		preview,
		closed,
		area: closed || closing ? polygonArea(placed) : null,
	};
});

export function clickMeasure(p: Point) {
	if (measureFinish.value) return;
	measurePoints.value = [...measurePoints.value, snapped(p)];
}

/** Ends the measurement, keeping it on the map; `shape` joins the last point back to the first. */
export function finishMeasure(how: "line" | "shape") {
	const n = measurePoints.value.length;
	if (measureFinish.value || n < (how === "shape" ? 3 : 2)) return false;
	measureFinish.value = how;
	measureFinishTarget.value = -1;
	return true;
}

/** Starts a new measurement with its first point at `p`. */
export function measureFrom(p: Point) {
	activeTool.value = "measure";
	measureFinish.value = null;
	measurePoints.value = [p];
}

/** Removes the last point, or on a finished measurement goes back to placing points. */
export function undoMeasure() {
	if (measureFinish.value) measureFinish.value = null;
	else measurePoints.value = measurePoints.value.slice(0, -1);
}

export function clearMeasure() {
	measureFinish.value = null;
	measureFinishTarget.value = -1;
	measurePoints.value = [];
}

export function hoverMeasure(p: Point | null) {
	if (!samePoint(p, measureHover.value)) measureHover.value = p;
}

/** Notes the first or last point under the pointer, which a click would finish on. */
export function hoverMeasureHandle(map: MapView, sx: number, sy: number) {
	const target = finishTargetAt(map, sx, sy);
	if (target !== measureFinishTarget.value) measureFinishTarget.value = target;
}

/**
 * Lets a placed point be dragged to a new block (Shift snaps it to a line from its neighbour).
 * A press that does not move is a click: on the first point it closes the shape, on the last
 * it ends the measurement.
 */
export function grabMeasurePoint(
	map: MapView,
	sx: number,
	sy: number,
): DragSession | null {
	const index = nearestHandle(map, measurePoints.value, sx, sy);
	if (index < 0) return null;
	const target = finishTargetAt(map, sx, sy);
	let dragging = false;
	return {
		move(mx, my) {
			if (!dragging) {
				if (Math.hypot(mx - sx, my - sy) < DRAG_START_PX) return;
				dragging = true;
				measureHover.value = null;
				measureFinishTarget.value = -1;
			}
			const points = [...measurePoints.value];
			const raw = blockAt(map, mx, my);
			const neighbour = points[index - 1] ?? points[index + 1];
			const next =
				shiftHeld.value && neighbour ? snapToLine(neighbour, raw) : raw;
			if (samePoint(next, points[index] ?? null)) return;
			points[index] = next;
			measurePoints.value = points;
		},
		end() {
			if (dragging || target < 0) return;
			finishMeasure(target === 0 ? "shape" : "line");
		},
		cancel() {},
	};
}

const numberFormat = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});
export const formatBlocks = (n: number) => numberFormat.format(n);

/** Overlay: the measured path, its segment lengths, the segment to the cursor and the points. */
export function drawMeasure(ctx: CanvasRenderingContext2D, map: MapView) {
	const stats = measureStats.value;
	if (!stats) return;
	const screen = stats.points.map((p) => blockCenter(map, p));
	const placedCount = stats.preview ? screen.length - 1 : screen.length;
	ctx.save();
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	if (stats.area !== null && placedCount >= 3) {
		ctx.beginPath();
		for (const [i, p] of screen.slice(0, placedCount).entries()) {
			if (i === 0) ctx.moveTo(p.x, p.y);
			else ctx.lineTo(p.x, p.y);
		}
		ctx.closePath();
		ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
		ctx.fill();
	}

	outlinedPath(ctx, screen.slice(0, placedCount), {
		color: "#fff",
		closed: stats.closed,
	});
	if (stats.preview)
		outlinedPath(ctx, screen.slice(placedCount - 1), {
			color: "#fff",
			dashed: true,
		});

	// Segment lengths at their midpoints, where there is room for them.
	stats.segments.forEach((length, i) => {
		const a = screen[i] as { x: number; y: number };
		const b = screen[(i + 1) % screen.length] as { x: number; y: number };
		const isPreview = stats.preview && i === stats.segments.length - 1;
		if (Math.hypot(b.x - a.x, b.y - a.y) < 70 && !isPreview) return;
		labelBox(
			ctx,
			formatBlocks(length),
			(a.x + b.x) / 2,
			(a.y + b.y) / 2,
			isPreview ? "#ffe866" : "#fff",
		);
	});

	// The point a click would finish on is drawn larger, so it is clear what the click will do.
	const target = measureFinishTarget.value;
	screen.slice(0, placedCount).forEach((s, i) => {
		const color = i === target ? "#ffe866" : i === 0 ? "#52a535" : "#fff";
		handleSquare(ctx, s.x, s.y, i === target ? 9 : 6, color);
	});

	// The total follows the end of the path once there is more than one segment.
	if (stats.segments.length > 1) {
		const end = screen.at(-1) as { x: number; y: number };
		const text =
			stats.area !== null
				? `Perimeter ${formatBlocks(stats.total)} · Area ${formatBlocks(stats.area)}`
				: `Total ${formatBlocks(stats.total)}`;
		labelBox(ctx, text, end.x, end.y - 26, "#ffe866");
	}
	ctx.restore();
}

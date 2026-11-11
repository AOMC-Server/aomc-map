import { computed, signal } from "@preact/signals";
import type { DragSession } from "../map/input";
import type { MapView } from "../map/MapView";
import { blockAt, blockCenter, nearestHandle, shiftHeld } from "./handles";
import {
	facing,
	type Point,
	pathLength,
	segmentLengths,
	snapToLine,
} from "./measureMath";
import { handleSquare, labelBox, outlinedPath } from "./overlay";

export type { Point };

/** The points placed so far (block coordinates), in order. */
export const measurePoints = signal<Point[]>([]);
/** The block under the cursor while measuring. */
export const measureHover = signal<Point | null>(null);

/** `p`, or with Shift held the nearest point on a straight line from the last placed one. */
function snapped(p: Point): Point {
	const last = measurePoints.value.at(-1);
	return shiftHeld.value && last ? snapToLine(last, p) : p;
}

/** Where a click would put the next point. */
const measureAim = computed(() => {
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
};

/** Numbers for the measure card, including the segment to the cursor while aiming. */
export const measureStats = computed<MeasureStats | null>(() => {
	const placed = measurePoints.value;
	if (placed.length === 0) return null;
	const aim = measureAim.value;
	const last = placed.at(-1) as Point;
	const preview = aim !== null && (aim.x !== last.x || aim.z !== last.z);
	const points = preview ? [...placed, aim] : placed;
	const first = points[0] as Point;
	const end = points.at(-1) as Point;
	const dx = end.x - first.x;
	const dz = end.z - first.z;
	return {
		points,
		segments: segmentLengths(points),
		total: pathLength(points),
		straight: Math.hypot(dx, dz),
		dx,
		dz,
		facing: dx === 0 && dz === 0 ? null : facing(dx, dz),
		preview,
	};
});

export function clickMeasure(p: Point) {
	measurePoints.value = [...measurePoints.value, snapped(p)];
}

export function undoMeasure() {
	measurePoints.value = measurePoints.value.slice(0, -1);
}

export function clearMeasure() {
	measurePoints.value = [];
}

export function hoverMeasure(p: Point | null) {
	measureHover.value = p;
}

/** Lets a placed point be dragged to a new block (Shift snaps it to a line from its neighbour). */
export function grabMeasurePoint(
	map: MapView,
	sx: number,
	sy: number,
): DragSession | null {
	const index = nearestHandle(map, measurePoints.value, sx, sy);
	if (index < 0) return null;
	measureHover.value = null;
	return {
		move(mx, my) {
			const points = [...measurePoints.value];
			const raw = blockAt(map, mx, my);
			const neighbour = points[index - 1] ?? points[index + 1];
			points[index] =
				shiftHeld.value && neighbour ? snapToLine(neighbour, raw) : raw;
			measurePoints.value = points;
		},
		end() {},
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

	outlinedPath(ctx, screen.slice(0, placedCount), { color: "#fff" });
	if (stats.preview)
		outlinedPath(ctx, screen.slice(placedCount - 1), {
			color: "#fff",
			dashed: true,
		});

	// Segment lengths at their midpoints, where there is room for them.
	stats.segments.forEach((length, i) => {
		const a = screen[i] as { x: number; y: number };
		const b = screen[i + 1] as { x: number; y: number };
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

	screen.slice(0, placedCount).forEach((s, i) => {
		handleSquare(ctx, s.x, s.y, 6, i === 0 ? "#52a535" : "#fff");
	});

	// The total follows the end of the path once there is more than one segment.
	if (stats.segments.length > 1) {
		const end = screen.at(-1) as { x: number; y: number };
		labelBox(
			ctx,
			`Total ${formatBlocks(stats.total)}`,
			end.x,
			end.y - 26,
			"#ffe866",
		);
	}
	ctx.restore();
}

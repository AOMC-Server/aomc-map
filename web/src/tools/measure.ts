import { computed, signal } from "@preact/signals";
import type { DragSession } from "../map/input";
import type { MapView } from "../map/MapView";
import { facing, type Point, segmentLengths, snapToLine } from "./measureMath";

export type { Point };

/** The points placed so far (block coordinates), in order. */
export const measurePoints = signal<Point[]>([]);
/** The block under the cursor while measuring: where the next point would go. */
export const measureHover = signal<Point | null>(null);

/** Shift is held: new points snap to straight lines from the last one. */
let snapping = false;

/** Where a click at `p` puts the next point, with Shift snapping applied. */
function nextPoint(p: Point): Point {
	const last = measurePoints.value.at(-1);
	return snapping && last ? snapToLine(last, p) : p;
}

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
	const hover = measureHover.value;
	const last = placed.at(-1) as Point;
	const preview = hover !== null && (hover.x !== last.x || hover.z !== last.z);
	const points = preview ? [...placed, hover] : placed;
	const segments = segmentLengths(points);
	const first = points[0] as Point;
	const end = points.at(-1) as Point;
	const dx = end.x - first.x;
	const dz = end.z - first.z;
	return {
		points,
		segments,
		total: segments.reduce((sum, s) => sum + s, 0),
		straight: Math.hypot(dx, dz),
		dx,
		dz,
		facing: dx === 0 && dz === 0 ? null : facing(dx, dz),
		preview,
	};
});

export function clickMeasure(p: Point) {
	measurePoints.value = [...measurePoints.value, nextPoint(p)];
}

export function undoMeasure() {
	measurePoints.value = measurePoints.value.slice(0, -1);
}

export function clearMeasure() {
	measurePoints.value = [];
}

export function hoverMeasure(p: Point | null) {
	measureHover.value = p && measurePoints.value.length > 0 ? nextPoint(p) : p;
}

export function setMeasureSnapping(on: boolean) {
	if (on === snapping) return;
	snapping = on;
	// Re-aim the preview with the new rule.
	const hover = measureHover.value;
	if (hover) measureHover.value = { ...hover };
}

const GRAB_RADIUS = 12;
const toBlock = (map: MapView, sx: number, sy: number): Point => {
	const b = map.screenToBlock(sx, sy);
	return { x: Math.floor(b.x), z: Math.floor(b.z) };
};
const center = (map: MapView, p: Point) =>
	map.blockToScreen(p.x + 0.5, p.z + 0.5);

/** Lets a placed point be dragged to a new block. */
export function grabMeasurePoint(
	map: MapView,
	sx: number,
	sy: number,
): DragSession | null {
	const points = measurePoints.value;
	let index = -1;
	let bestDist = GRAB_RADIUS;
	points.forEach((p, i) => {
		const s = center(map, p);
		const dist = Math.hypot(s.x - sx, s.y - sy);
		if (dist <= bestDist) {
			index = i;
			bestDist = dist;
		}
	});
	if (index < 0) return null;
	measureHover.value = null;
	return {
		move(mx, my) {
			const next = [...measurePoints.value];
			next[index] = toBlock(map, mx, my);
			measurePoints.value = next;
		},
		end() {},
	};
}

const numberFormat = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});
export const formatBlocks = (n: number) => numberFormat.format(n);

const LINE = "#ffffff";
const OUTLINE = "rgba(30, 30, 31, 0.9)";
const FONT = '600 12px "Noto Sans", "Segoe UI", system-ui, sans-serif';

/** A dark label with a light outline, centred on (x, y). */
function label(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	color = "#fff",
) {
	ctx.font = FONT;
	const w = Math.ceil(ctx.measureText(text).width) + 12;
	const h = 20;
	const left = Math.round(x - w / 2);
	const top = Math.round(y - h / 2);
	ctx.fillStyle = "#1e1e1f";
	ctx.fillRect(left - 2, top - 2, w + 4, h + 4);
	ctx.fillStyle = "#313233";
	ctx.fillRect(left, top, w, h);
	ctx.fillStyle = color;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, left + w / 2, top + h / 2 + 1);
}

function strokePath(
	ctx: CanvasRenderingContext2D,
	pts: { x: number; y: number }[],
	dashed: boolean,
) {
	ctx.beginPath();
	for (const [i, p] of pts.entries()) {
		if (i === 0) ctx.moveTo(p.x, p.y);
		else ctx.lineTo(p.x, p.y);
	}
	ctx.setLineDash(dashed ? [8, 6] : []);
	ctx.lineWidth = 6;
	ctx.strokeStyle = OUTLINE;
	ctx.stroke();
	ctx.lineWidth = 2.5;
	ctx.strokeStyle = LINE;
	ctx.stroke();
	ctx.setLineDash([]);
}

/** Overlay: the measured path, its segment lengths, the segment to the cursor and the points. */
export function drawMeasure(ctx: CanvasRenderingContext2D, map: MapView) {
	const stats = measureStats.value;
	if (!stats) return;
	const screen = stats.points.map((p) => center(map, p));
	const placedCount = stats.preview ? screen.length - 1 : screen.length;
	ctx.save();
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	strokePath(ctx, screen.slice(0, placedCount), false);
	if (stats.preview) strokePath(ctx, screen.slice(placedCount - 1), true);

	// Segment lengths at their midpoints, where there is room for them.
	stats.segments.forEach((length, i) => {
		const a = screen[i] as { x: number; y: number };
		const b = screen[i + 1] as { x: number; y: number };
		const isPreview = stats.preview && i === stats.segments.length - 1;
		if (Math.hypot(b.x - a.x, b.y - a.y) < 70 && !isPreview) return;
		label(
			ctx,
			`${formatBlocks(length)}`,
			(a.x + b.x) / 2,
			(a.y + b.y) / 2,
			isPreview ? "#ffe866" : "#fff",
		);
	});

	// Points: squares, the first one green.
	screen.slice(0, placedCount).forEach((s, i) => {
		const r = 6;
		ctx.fillStyle = "#1e1e1f";
		ctx.fillRect(
			Math.round(s.x) - r - 2,
			Math.round(s.y) - r - 2,
			r * 2 + 4,
			r * 2 + 4,
		);
		ctx.fillStyle = i === 0 ? "#52a535" : "#ffffff";
		ctx.fillRect(Math.round(s.x) - r, Math.round(s.y) - r, r * 2, r * 2);
	});

	// The total follows the end of the path once there is more than one segment.
	if (stats.segments.length > 1) {
		const end = screen.at(-1) as { x: number; y: number };
		label(
			ctx,
			`Total ${formatBlocks(stats.total)}`,
			end.x,
			end.y - 26,
			"#ffe866",
		);
	}
	ctx.restore();
}

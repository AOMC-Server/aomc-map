import type { FeatureType, Point } from "@aomc/shared/features";
import { signal } from "@preact/signals";
import { BLOCK_CENTER } from "../map/featureLayer";
import { type DragSession, isTyping } from "../map/input";
import type { MapView } from "../map/MapView";

/**
 * Geometry placement for the feature editor.
 *
 * Click adds a vertex, dragging a vertex moves it, Enter finishes placing, Esc cancels,
 * Backspace removes the last vertex. A pin is a single vertex.
 */
export type DrawState = {
	type: FeatureType;
	points: Point[];
	/** "draw": clicks add vertices. "placed": geometry is complete; only dragging edits it. */
	mode: "draw" | "placed";
};

export const drawing = signal<DrawState | null>(null);

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

export function setDrawType(type: FeatureType) {
	if (!drawing.value) return;
	drawing.value = { type, points: [], mode: "draw" };
}

export function resumeDraw() {
	const d = drawing.value;
	if (d && d.type !== "pin") drawing.value = { ...d, mode: "draw" };
	else if (d) drawing.value = { ...d, points: [], mode: "draw" };
}

export function finishDraw(): boolean {
	const d = drawing.value;
	if (!d || d.points.length < minPoints(d.type)) return false;
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
	onCancel = null;
}

function cancelDraw() {
	const cancel = onCancel;
	stopDraw();
	cancel?.();
}

const HANDLE_RADIUS = 6;
const GRAB_RADIUS = 12;

const toBlock = (map: MapView, sx: number, sy: number): Point => {
	const b = map.screenToBlock(sx, sy);
	return [Math.floor(b.x), Math.floor(b.z)];
};

/** Screen position of the pointer, for the rubber band line while placing vertices. */
let pointer: { sx: number; sy: number } | null = null;

export function initDrawTool(map: MapView) {
	map.on("move", (e) => {
		pointer = e ? { sx: e.sx, sy: e.sy } : null;
		if (drawing.value?.mode === "draw") map.invalidate();
	});
	map.on("click", (e) => {
		const d = drawing.value;
		if (d?.mode !== "draw") return;
		const p = toBlock(map, e.sx, e.sy);
		if (d.type === "pin") drawing.value = { ...d, points: [p], mode: "placed" };
		else drawing.value = { ...d, points: [...d.points, p] };
	});

	window.addEventListener("keydown", (e) => {
		const d = drawing.value;
		if (!d || isTyping(e.target)) return;
		if (e.key === "Enter") {
			if (finishDraw()) e.preventDefault();
		} else if (e.key === "Escape") {
			cancelDraw();
			e.preventDefault();
		} else if (e.key === "Backspace" || e.key === "Delete") {
			undoPoint();
			e.preventDefault();
		}
	});
}

/** Lets a vertex of the geometry being placed be dragged to a new block. */
export function grabDrawPoint(
	map: MapView,
	sx: number,
	sy: number,
): DragSession | null {
	const d = drawing.value;
	if (!d) return null;
	let best = -1;
	let bestDist = GRAB_RADIUS;
	d.points.forEach(([x, z], i) => {
		const s = map.blockToScreen(x + BLOCK_CENTER, z + BLOCK_CENTER);
		const dist = Math.hypot(s.x - sx, s.y - sy);
		if (dist <= bestDist) {
			best = i;
			bestDist = dist;
		}
	});
	if (best < 0) return null;
	const index = best;
	return {
		move(mx, my) {
			const current = drawing.value;
			if (!current) return;
			const points = [...current.points];
			points[index] = toBlock(map, mx, my);
			drawing.value = { ...current, points };
		},
		end() {},
	};
}

/** Overlay: the geometry being placed, with vertex handles. */
export function drawGeometry(ctx: CanvasRenderingContext2D, map: MapView) {
	const d = drawing.value;
	if (!d || d.points.length === 0) return;
	const pts = d.points.map(([x, z]) =>
		map.blockToScreen(x + BLOCK_CENTER, z + BLOCK_CENTER),
	);
	ctx.save();
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	if (d.type !== "pin") {
		ctx.beginPath();
		for (const [i, p] of pts.entries()) {
			if (i === 0) ctx.moveTo(p.x, p.y);
			else ctx.lineTo(p.x, p.y);
		}
		if (d.type === "polygon" && d.mode === "placed") ctx.closePath();
		ctx.strokeStyle = "#ffd23f";
		ctx.lineWidth = 3;
		ctx.stroke();
		if (d.mode === "draw" && pointer) {
			const last = pts[pts.length - 1];
			if (last) {
				ctx.setLineDash([6, 5]);
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.moveTo(last.x, last.y);
				ctx.lineTo(pointer.sx, pointer.sy);
				if (d.type === "polygon" && pts.length >= 2)
					ctx.lineTo((pts[0] as { x: number }).x, (pts[0] as { y: number }).y);
				ctx.stroke();
				ctx.setLineDash([]);
			}
		}
	}
	pts.forEach((p, i) => {
		ctx.beginPath();
		ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
		ctx.fillStyle = i === 0 && d.type !== "pin" ? "#3fe08a" : "#fff";
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = "#000";
		ctx.stroke();
	});
	ctx.restore();
}

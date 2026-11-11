import { effect } from "@preact/signals";
import { isUiKeyTarget } from "../map/input";
import type { MapView } from "../map/MapView";
import { activeTool, contextMenu, cursor, highlightedUpload } from "../state";
import { areasLoaded, type Edge, type Rect, uploadArea } from "../uploadArea";
import {
	drawGeometry,
	drawing,
	focusedPoint,
	grabDrawPoint,
	initDrawTool,
} from "./draw";
import { initFeatureInteraction } from "./features";
import { floorBlock, shiftHeld } from "./handles";
import {
	clearMeasure,
	clickMeasure,
	drawMeasure,
	grabMeasurePoint,
	hoverMeasure,
	measureHover,
	measurePoints,
	undoMeasure,
} from "./measure";
import { samePoint } from "./measureMath";

/**
 * Outlines the area of the upload that is hovered or selected in the upload log: the tiles it
 * covers, or its bounding box when those are unknown.
 */
function drawHighlight(ctx: CanvasRenderingContext2D, map: MapView) {
	const r = highlightedUpload.value;
	if (!r) return;
	const area = uploadArea(r);
	if (area === undefined) return;
	const b = r.bbox;
	const rects: Rect[] = area
		? area.rects
		: b
			? [{ x0: b.minX, z0: b.minZ, x1: b.maxX + 1, z1: b.maxZ + 1 }]
			: [];
	const edges: Edge[] = area
		? area.edges
		: rects.flatMap(({ x0, z0, x1, z1 }) => [
				{ x0, z0, x1, z1: z0 },
				{ x0: x1, z0, x1, z1 },
				{ x0: x1, z0: z1, x1: x0, z1 },
				{ x0, z0: z1, x1: x0, z1: z0 },
			]);
	if (rects.length === 0) return;

	ctx.save();
	ctx.beginPath();
	for (const q of rects) {
		const a = map.blockToScreen(q.x0, q.z0);
		const c = map.blockToScreen(q.x1, q.z1);
		ctx.rect(a.x, a.y, c.x - a.x, c.y - a.y);
	}
	ctx.fillStyle = "rgba(255, 210, 63, 0.18)";
	ctx.fill();
	ctx.beginPath();
	for (const e of edges) {
		const a = map.blockToScreen(e.x0, e.z0);
		const c = map.blockToScreen(e.x1, e.z1);
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(c.x, c.y);
	}
	// A dark halo keeps the outline visible over bright terrain, and small far-off tiles visible
	// when zoomed out.
	ctx.lineCap = "square";
	ctx.lineWidth = 4;
	ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
	ctx.stroke();
	ctx.setLineDash([8, 5]);
	ctx.lineWidth = 2;
	ctx.strokeStyle = "#ffd23f";
	ctx.stroke();
	ctx.restore();
}

/** Connects the overlays, click, hover and keyboard handling of the tools to the map. */
export function initTools(map: MapView) {
	map.overlays.push(drawHighlight, drawMeasure, drawGeometry);
	initDrawTool(map);
	initFeatureInteraction(map);
	map.dragHandler = (sx, sy) =>
		grabDrawPoint(map, sx, sy) ??
		(activeTool.value === "measure" ? grabMeasurePoint(map, sx, sy) : null);

	// Everything the overlays draw from; any change repaints the map.
	effect(() => {
		highlightedUpload.value;
		areasLoaded.value;
		measurePoints.value;
		measureHover.value;
		drawing.value;
		focusedPoint.value;
		shiftHeld.value;
		map.invalidate();
	});

	map.on("move", (e) => {
		const block = e ? floorBlock(e) : null;
		// A new object would repaint the map on every pointer move, even within one block.
		if (!samePoint(block, cursor.value)) cursor.value = block;
		if (activeTool.value === "measure") hoverMeasure(cursor.value);
	});
	map.on("contextmenu", (e) => {
		contextMenu.value = { ...floorBlock(e), anchor: { x: e.x, z: e.z } };
	});
	map.on("click", (e) => {
		if (drawing.value) return;
		if (activeTool.value === "measure") clickMeasure(floorBlock(e));
	});

	// Double-click zoom would fight with two quick tool clicks.
	effect(() => {
		const tool = activeTool.value;
		const idle = tool === "none" && drawing.value === null;
		map.doubleClickZoom = idle;
		map.setCursor(idle ? "grab" : "crosshair");
		if (tool !== "measure") {
			clearMeasure();
			hoverMeasure(null);
		}
	});

	const shift = (e: KeyboardEvent) => {
		shiftHeld.value = e.shiftKey;
	};
	window.addEventListener("keyup", shift);
	window.addEventListener("blur", () => {
		shiftHeld.value = false;
	});
	window.addEventListener("keydown", (e) => {
		shift(e);
		if (isUiKeyTarget(e.target) || drawing.value) return;
		if (e.key === "Escape") {
			if (measurePoints.value.length > 0) clearMeasure();
			else activeTool.value = "none";
		} else if (
			(e.key === "Backspace" || e.key === "Delete") &&
			activeTool.value === "measure" &&
			measurePoints.value.length > 0
		) {
			undoMeasure();
			e.preventDefault();
		}
	});
}

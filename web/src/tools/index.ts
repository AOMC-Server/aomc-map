import { effect } from "@preact/signals";
import { isTyping } from "../map/input";
import type { MapView } from "../map/MapView";
import { activeTool, cursor, highlightBbox } from "../state";
import { drawGeometry, drawing, initDrawTool } from "./draw";
import { initFeatureInteraction } from "./features";
import {
	clearMeasure,
	clickMeasure,
	drawMeasure,
	measurePoints,
} from "./measure";

/** Outlines the area of the upload that is hovered or selected in the upload log. */
function drawHighlight(ctx: CanvasRenderingContext2D, map: MapView) {
	const b = highlightBbox.value;
	if (!b) return;
	const a = map.blockToScreen(b.minX, b.minZ);
	const c = map.blockToScreen(b.maxX + 1, b.maxZ + 1);
	ctx.save();
	ctx.fillStyle = "rgba(255, 210, 63, 0.14)";
	ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
	ctx.setLineDash([8, 5]);
	ctx.lineWidth = 2;
	ctx.strokeStyle = "#ffd23f";
	ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
	ctx.restore();
}

/** Connects the overlays, click, hover and keyboard handling of the tools to the map. */
export function initTools(map: MapView) {
	map.overlays.push(drawHighlight, drawMeasure, drawGeometry);
	initDrawTool(map);
	initFeatureInteraction(map);

	// Everything the overlays draw from; any change repaints the map.
	effect(() => {
		highlightBbox.value;
		measurePoints.value;
		drawing.value;
		map.invalidate();
	});

	map.on("move", (e) => {
		cursor.value = e ? { x: Math.floor(e.x), z: Math.floor(e.z) } : null;
	});
	map.on("click", (e) => {
		if (drawing.value) return;
		const p = { x: Math.floor(e.x), z: Math.floor(e.z) };
		if (activeTool.value === "measure") clickMeasure(p);
	});

	// Double-click zoom would fight with two quick tool clicks.
	effect(() => {
		const tool = activeTool.value;
		const idle = tool === "none" && drawing.value === null;
		map.doubleClickZoom = idle;
		map.setCursor(idle ? "grab" : "crosshair");
		if (tool !== "measure") clearMeasure();
	});

	window.addEventListener("keydown", (e) => {
		if (isTyping(e.target) || e.key !== "Escape" || drawing.value) return;
		if (measurePoints.value.length > 0) clearMeasure();
		else activeTool.value = "none";
	});
}

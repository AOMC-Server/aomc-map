import { effect } from "@preact/signals";
import type { MapView } from "../map/MapView";
import {
	activeTool,
	centerBlock,
	cursor,
	draftLook,
	editor,
	highlightedUpload,
	layersData,
	noHover,
} from "../state";
import { areasLoaded, type Edge, type Rect, uploadArea } from "../uploadArea";
import { featureShape } from "./draw";
import { initFeatureInteraction } from "./features";
import { floorBlock, shiftHeld } from "./handles";
import { drawMeasure, endMeasure, measureShape, startMeasure } from "./measure";
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
	map.overlays.push(drawHighlight, drawMeasure, featureShape.draw);
	featureShape.init(map);
	measureShape.init(map);
	initFeatureInteraction(map);
	// Each editor passes on a press that is not on one of its own points.
	map.dragHandler = (sx, sy) =>
		featureShape.grab(map, sx, sy) ?? measureShape.grab(map, sx, sy);
	map.cursorHandler = (sx, sy) =>
		featureShape.cursor(map, sx, sy) ?? measureShape.cursor(map, sx, sy);

	// Everything the overlays draw from; any change repaints the map.
	effect(() => {
		highlightedUpload.value;
		areasLoaded.value;
		featureShape.state.value;
		featureShape.focused.value;
		featureShape.hover.value;
		featureShape.hoverVertex.value;
		measureShape.state.value;
		measureShape.aimed.value;
		shiftHeld.value;
		activeTool.value;
		map.invalidate();
		// What a click would do may have changed under a mouse that has not moved.
		map.refreshCursor();
	});

	map.on("move", (e) => {
		const block = e ? floorBlock(e) : null;
		// A new object would repaint the map on every pointer move, even within one block.
		if (!samePoint(block, cursor.value)) cursor.value = block;
	});
	// On touch screens the measure tool aims at the crosshair in the middle of the screen.
	effect(() => {
		if (activeTool.value === "measure" && noHover.value) {
			const c = centerBlock.value;
			measureShape.setHover([c.x, c.z]);
		}
	});

	// The feature being edited is drawn in its new shape and style as it is edited.
	effect(() => {
		const d = featureShape.state.value;
		const target = editor.value;
		const look = draftLook.value;
		const layer = target
			? layersData.value.find((l) => l.id === target.layerId)
			: undefined;
		const draft = featureShape.draft.value;
		if (!d || !draft || !target || !layer || !look) {
			map.setDraftFeature({ id: 0, color: "white" }, null, null);
			return;
		}
		map.setDraftFeature(
			layer,
			{
				id: -1,
				layerId: layer.id,
				type: draft.type,
				name: "",
				popup: "",
				color: look.color,
				style: look.style,
				geometry: draft.geometry,
			},
			target.mode === "edit" ? target.featureId : null,
		);
	});

	// The measurement lasts as long as the tool is open.
	effect(() => {
		if (activeTool.value === "measure") startMeasure();
		else endMeasure();
	});

	// Double-click zoom would fight with two quick tool clicks.
	effect(() => {
		const idle =
			activeTool.value === "none" && featureShape.state.value === null;
		map.doubleClickZoom = idle;
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
	});
}

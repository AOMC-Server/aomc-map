import { effect } from "@preact/signals";
import type { MapView } from "../map/MapView";
import { activeTool, cursor } from "../state";
import {
	clearCopy,
	clickCopy,
	copiedPoints,
	drawCopy,
	watchCopy,
} from "./copyCoords";
import {
	clearMeasure,
	clickMeasure,
	drawMeasure,
	measurePoints,
	watchMeasure,
} from "./measure";

/** Connects the click, hover and keyboard handling of the tools to a map. Returns a disposer. */
export function initTools(map: MapView): () => void {
	const disposers: (() => void)[] = [];

	map.setOverlay("measure", drawMeasure);
	map.setOverlay("copy", drawCopy);
	disposers.push(watchMeasure(map), watchCopy(map));

	disposers.push(
		map.on("move", (e) => {
			cursor.value = e ? { x: Math.floor(e.x), z: Math.floor(e.z) } : null;
		}),
		map.on("click", (e) => {
			const p = { x: Math.floor(e.x), z: Math.floor(e.z) };
			if (activeTool.value === "measure") clickMeasure(p);
			else if (activeTool.value === "copy") void clickCopy(p);
		}),
	);

	// Double-click zoom would fight with two quick tool clicks.
	disposers.push(
		effect(() => {
			const tool = activeTool.value;
			map.setDoubleClickZoom(tool === "none");
			map.setCursor(tool === "none" ? "grab" : "crosshair");
			if (tool !== "measure") clearMeasure();
			if (tool !== "copy") clearCopy();
		}),
	);

	const onKey = (e: KeyboardEvent) => {
		const t = e.target as HTMLElement | null;
		if (
			t &&
			(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
		)
			return;
		if (e.key !== "Escape") return;
		if (measurePoints.value.length > 0) clearMeasure();
		else if (copiedPoints.value.length > 0) clearCopy();
		else activeTool.value = "none";
	};
	window.addEventListener("keydown", onKey);
	disposers.push(() => window.removeEventListener("keydown", onKey));

	return () => {
		for (const dispose of disposers) dispose();
		map.setOverlay("measure", null);
		map.setOverlay("copy", null);
		cursor.value = null;
	};
}

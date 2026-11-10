import { effect } from "@preact/signals";
import type { MapView } from "../map/MapView";
import { highlightBbox } from "../state";

/** Outlines the area of the upload that is hovered or selected in the upload log. */
export function initHistoryOverlay(map: MapView): () => void {
	map.setOverlay("history-bbox", (ctx) => {
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
	});
	const stop = effect(() => {
		highlightBbox.value;
		map.invalidate();
	});
	return () => {
		stop();
		map.setOverlay("history-bbox", null);
	};
}

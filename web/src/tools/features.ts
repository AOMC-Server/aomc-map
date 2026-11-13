import type { FeatureType } from "@aomc/shared/features";
import { effect } from "@preact/signals";
import { pointsOf } from "../featureInfo";
import { BLOCK_CENTER, MIN_CLUSTER_LEVEL } from "../map/featureLayer";
import { boundsOf } from "../map/geometry";
import type { MapView } from "../map/MapView";
import { activeTool, contextMenu, editor, hoverInfo, popup } from "../state";
import { drawing, featureShape } from "./draw";
import { floorBlock } from "./handles";
import { measureShape } from "./measure";

/**
 * Opens the popup of a feature. A pin's popup sits on the pin; a line's or area's on the spot
 * that was clicked, or without one in the middle of its bounds.
 */
export function openFeaturePopup(
	f: { id: number; layerId: number; type: FeatureType; geometry: unknown },
	clicked?: { x: number; z: number },
) {
	const points = pointsOf(f);
	const [first] = points;
	let anchor: { x: number; z: number };
	if (f.type === "pin" && first)
		anchor = { x: first[0] + BLOCK_CENTER, z: first[1] + BLOCK_CENTER };
	else if (clicked) anchor = clicked;
	else {
		const b = boundsOf(points);
		anchor = {
			x: (b.minX + b.maxX) / 2 + BLOCK_CENTER,
			z: (b.minZ + b.maxZ) / 2 + BLOCK_CENTER,
		};
	}
	contextMenu.value = null;
	popup.value = {
		featureId: f.id,
		layerId: f.layerId,
		...anchor,
		at: floorBlock(anchor),
	};
}

/** Hover tooltips, click popups, the right-click menu, cluster zoom and selection highlighting. */
export function initFeatureInteraction(map: MapView) {
	const busy = () => activeTool.value !== "none" || drawing.value !== null;

	map.on("hover", ({ hit, sx, sy }) => {
		if (!hit || busy()) {
			hoverInfo.value = null;
			return;
		}
		// A feature without a name has nothing to show on hover.
		const text =
			hit.kind === "cluster" ? `${hit.count} pins` : hit.feature.name.trim();
		const dye =
			hit.kind === "feature"
				? (hit.feature.color ?? hit.layer.color)
				: undefined;
		hoverInfo.value = text ? { text, sx, sy, dye } : null;
	});
	map.on("move", (e) => {
		const current = hoverInfo.value;
		if (current && e) hoverInfo.value = { ...current, sx: e.sx, sy: e.sy };
		else if (!e) hoverInfo.value = null;
	});
	map.on("click", (e) => {
		if (busy()) return;
		const { hit } = e;
		if (!hit) {
			popup.value = null;
			return;
		}
		if (hit.kind === "cluster") {
			// Stop short of the zoom where pins are clustered, so the cluster always opens up.
			map.fitBounds(hit.bounds, {
				padding: 120,
				closestZoom: MIN_CLUSTER_LEVEL - 0.5,
			});
			return;
		}
		openFeaturePopup(hit.feature, e);
	});
	// A right click on a vertex being placed removes it; on a feature it opens the same popup as a
	// click; anywhere else, the map's menu.
	map.on("contextmenu", (e) => {
		if (featureShape.removeAt(map, e.sx, e.sy)) return;
		if (measureShape.removeAt(map, e.sx, e.sy)) return;
		if (!busy() && e.hit?.kind === "feature") {
			openFeaturePopup(e.hit.feature, e);
			return;
		}
		popup.value = null;
		contextMenu.value = { ...floorBlock(e), anchor: { x: e.x, z: e.z } };
	});
	effect(() => {
		const selected =
			editor.value?.mode === "edit"
				? editor.value.featureId
				: (popup.value?.featureId ?? null);
		map.setSelectedFeature(selected);
	});
}

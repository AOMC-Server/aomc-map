import { effect } from "@preact/signals";
import { pointsOf } from "../featureInfo";
import { MIN_CLUSTER_LEVEL } from "../map/featureLayer";
import type { MapView } from "../map/MapView";
import { activeTool, editor, hoverInfo, popup } from "../state";
import { drawing } from "./draw";

/** Hover tooltips, click popups, cluster zoom and selection highlighting for features. */
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
		hoverInfo.value = text ? { text, sx, sy } : null;
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
		const f = hit.feature;
		const [first] = pointsOf(f);
		const anchor =
			f.type === "pin" && first
				? { x: first[0] + 0.5, z: first[1] + 0.5 }
				: { x: e.x, z: e.z };
		popup.value = { featureId: f.id, layerId: f.layerId, ...anchor };
	});
	effect(() => {
		const selected =
			editor.value?.mode === "edit"
				? editor.value.featureId
				: (popup.value?.featureId ?? null);
		map.setSelectedFeature(selected);
	});
}

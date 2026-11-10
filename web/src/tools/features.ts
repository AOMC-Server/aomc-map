import type { Point } from "@aomc/shared/features";
import { effect } from "@preact/signals";
import type { MapView } from "../map/MapView";
import { activeTool, editor, hoverInfo, popup } from "../state";
import { drawing } from "./draw";

const TYPE_LABEL = { pin: "Pin", line: "Line", polygon: "Area" } as const;

/** Hover tooltips, click popups, cluster zoom and selection highlighting for features. */
export function initFeatureInteraction(map: MapView): () => void {
	const busy = () => activeTool.value !== "none" || drawing.value !== null;

	const disposers = [
		map.on("hover", ({ hit, sx, sy }) => {
			if (!hit || busy()) {
				hoverInfo.value = null;
				return;
			}
			const text =
				hit.kind === "cluster"
					? `${hit.count} pins`
					: hit.feature.name || TYPE_LABEL[hit.feature.type];
			hoverInfo.value = { text, sx, sy };
		}),
		map.on("move", (e) => {
			const current = hoverInfo.value;
			if (current && e) hoverInfo.value = { ...current, sx: e.sx, sy: e.sy };
			else if (!e) hoverInfo.value = null;
		}),
		map.on("click", (e) => {
			if (busy()) return;
			const { hit } = e;
			if (!hit) {
				popup.value = null;
				return;
			}
			if (hit.kind === "cluster") {
				map.fitBounds(hit.bounds, { padding: 120 });
				return;
			}
			const f = hit.feature;
			const anchor =
				f.type === "pin"
					? {
							x: (f.geometry as Point)[0] + 0.5,
							z: (f.geometry as Point)[1] + 0.5,
						}
					: { x: e.x, z: e.z };
			popup.value = { featureId: f.id, layerId: f.layerId, ...anchor };
		}),
		effect(() => {
			const selected =
				editor.value?.mode === "edit"
					? editor.value.featureId
					: (popup.value?.featureId ?? null);
			map.setSelectedFeature(selected);
		}),
	];

	return () => {
		for (const dispose of disposers) dispose();
		hoverInfo.value = null;
		map.setSelectedFeature(null);
	};
}

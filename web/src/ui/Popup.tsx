import { DYE_HEX } from "@aomc/shared/colors";
import { mapView } from "../controller";
import { deleteFeature } from "../layers";
import { canEditMap, editor, layersData, popup, view } from "../state";
import { featureHistoryFor } from "./FeatureHistory";
import { PopupText } from "./PopupText";

const TYPE_LABEL = { pin: "Pin", line: "Line", polygon: "Area" } as const;

/** DOM popup for the clicked feature, anchored to the map position and following pans and zooms. */
export function Popup() {
	const p = popup.value;
	const mv = mapView.value;
	view.value; // re-render when the camera moves
	if (!p || !mv) return null;

	const layer = layersData.value.find((l) => l.id === p.layerId);
	const feature = layer?.features.find((f) => f.id === p.featureId);
	if (!layer || !feature) return null;

	const at = mv.blockToScreen(p.x, p.z);
	const size = mv.getSize();
	const left = Math.min(Math.max(at.x, 150), size.width - 150);
	const placeBelow = at.y < 190;
	const top = placeBelow
		? at.y + 14
		: at.y - (feature.type === "pin" ? 34 : 12);
	const color = DYE_HEX[feature.color ?? layer.color];
	const editable = layer.canEdit && canEditMap.value;

	return (
		<div
			class={`popup ${placeBelow ? "below" : ""}`}
			style={{ left: `${left}px`, top: `${top}px` }}
			role="dialog"
			aria-label={feature.name || TYPE_LABEL[feature.type]}
		>
			<button
				type="button"
				class="popup-close"
				aria-label="Close"
				onClick={() => (popup.value = null)}
			>
				×
			</button>
			<h3>
				<span class="swatch" style={{ background: color }} />
				{feature.name || TYPE_LABEL[feature.type]}
			</h3>
			<div class="popup-meta">
				{TYPE_LABEL[feature.type]} · {layer.name}
			</div>
			{feature.popup && <PopupText text={feature.popup} />}
			<div class="popup-actions">
				{editable && (
					<>
						<button
							type="button"
							class="btn"
							onClick={() => {
								popup.value = null;
								editor.value = {
									mode: "edit",
									layerId: layer.id,
									featureId: feature.id,
								};
							}}
						>
							Edit
						</button>
						<button
							type="button"
							class="btn"
							onClick={async () => {
								if (
									!confirm(
										`Delete "${feature.name || TYPE_LABEL[feature.type]}"?`,
									)
								)
									return;
								popup.value = null;
								await deleteFeature(feature.id);
							}}
						>
							Delete
						</button>
					</>
				)}
				<button
					type="button"
					class="btn"
					onClick={() => {
						featureHistoryFor.value = {
							featureId: feature.id,
							title: feature.name || TYPE_LABEL[feature.type],
						};
					}}
				>
					History
				</button>
			</div>
		</div>
	);
}

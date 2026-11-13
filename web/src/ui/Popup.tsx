import { mapView } from "../controller";
import { featureStats, featureTitle, TYPE_LABEL } from "../featureInfo";
import { deleteFeature } from "../layers";
import { resolveStyle } from "../map/featureStyle";
import { canEditMap, editor, embed, layersData, popup, view } from "../state";
import { dyeScope } from "../theme";
import { measureFrom } from "../tools/measure";
import { formatBlocks } from "../tools/measureMath";
import { featureHistoryFor } from "./FeatureHistory";
import { Banner } from "./icons";
import { PopupText } from "./PopupText";
import { copyText, copyWaypoint } from "./shareCommon";

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
	const dye = feature.color ?? layer.color;
	const editable = layer.canEdit && canEditMap.value;
	const spot = p.at;
	const stats = featureStats(
		feature,
		resolveStyle(feature.style, feature.type === "polygon", layer.style).smooth,
	);

	return (
		<div class="dye-scope" {...dyeScope(dye)}>
			<div
				class={`popup ${placeBelow ? "below" : ""}`}
				style={{ left: `${left}px`, top: `${top}px` }}
				role="dialog"
				aria-label={featureTitle(feature)}
			>
				<button
					type="button"
					class="btn small close popup-close"
					aria-label="Close"
					onClick={() => (popup.value = null)}
				>
					×
				</button>
				<h3 class={`dye-${dye}`}>
					<Banner dye={dye} />
					{featureTitle(feature)}
				</h3>
				<div class="popup-meta">
					<span class="popup-kind">
						{TYPE_LABEL[feature.type]} · {layer.name}
					</span>
					<button
						type="button"
						class="plain popup-coords"
						title="Copy the coordinates (x, z)"
						onClick={() =>
							void copyText(
								`${spot.x}, ${spot.z}`,
								`Copied ${spot.x}, ${spot.z}`,
							)
						}
					>
						{spot.x}, {spot.z}
					</button>
				</div>
				{(stats.length !== undefined || stats.area !== undefined) && (
					<p class="popup-stats">
						{stats.length !== undefined && (
							<span>Length: {formatBlocks(stats.length)} blocks</span>
						)}
						{stats.perimeter !== undefined && (
							<span>Perimeter: {formatBlocks(stats.perimeter)} blocks</span>
						)}
						{stats.area !== undefined && (
							<span>Area: {formatBlocks(stats.area)} blocks²</span>
						)}
					</p>
				)}
				{feature.popup && <PopupText text={feature.popup} />}
				<div class="popup-footer">
					<div class="popup-actions">
						<button
							type="button"
							class="btn small"
							title="Copy a waypoint for Xaero's Minimap; paste it in Minecraft chat to share it"
							onClick={() =>
								copyWaypoint({ name: feature.name, ...spot, color: dye })
							}
						>
							Copy waypoint
						</button>
						{!embed.value && (
							<button
								type="button"
								class="btn small"
								title="Measure from here"
								onClick={() => {
									popup.value = null;
									measureFrom(spot);
								}}
							>
								Measure
							</button>
						)}
					</div>
					<div class="popup-actions">
						{editable && (
							<button
								type="button"
								class="btn small"
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
						)}
						<button
							type="button"
							class="btn small"
							onClick={() => {
								featureHistoryFor.value = {
									featureId: feature.id,
									title: featureTitle(feature),
								};
							}}
						>
							History
						</button>
						{editable && (
							<button
								type="button"
								class="btn small danger"
								onClick={async () => {
									if (!confirm(`Delete "${featureTitle(feature)}"?`)) return;
									popup.value = null;
									await deleteFeature(feature.id);
								}}
							>
								Delete
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

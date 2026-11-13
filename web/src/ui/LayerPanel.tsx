import type { Dye } from "@aomc/shared/colors";
import {
	cleanStyle,
	type FeatureInput,
	type FeatureStyle,
	MAX_NAME,
} from "@aomc/shared/features";
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { showNotice } from "../api";
import { mapView } from "../controller";
import { featureTitle, pointsOf, TYPE_LABEL } from "../featureInfo";
import { type LayerMatch, searchLayers } from "../layerSearch";
import {
	createLayer,
	deleteFeature,
	deleteLayer,
	importFeatures,
	reorderFeatures,
	reorderLayers,
	updateLayer,
} from "../layers";
import { boundsOf } from "../map/geometry";
import { moveItem } from "../reorder";
import {
	canEditMap,
	currentMap,
	editor,
	type FeatureData,
	isLayerFull,
	isLayerHidden,
	type LayerData,
	layerLimitReached,
	layersData,
	setLayersHidden,
	showOnlyLayer,
	sidePanel,
	toggleLayer,
	user,
} from "../state";
import { openFeaturePopup } from "../tools/features";
import { DyePicker } from "./DyePicker";
import { Grip } from "./Grip";
import { Banner } from "./icons";
import { layerSharingFor } from "./LayerSharing";
import { Panel } from "./Panel";
import { StyleControls } from "./StyleControls";

/** Layers that are expanded in the list; kept when the panel is closed and reopened. */
const openLayers = signal<Set<number>>(new Set());

function toggleOpen(id: number) {
	const next = new Set(openLayers.value);
	if (!next.delete(id)) next.add(id);
	openLayers.value = next;
}

/** A layer that is hidden would show nothing at the place we are taking the user to. */
function reveal(layerId: number) {
	const layer = layersData.value.find((l) => l.id === layerId);
	if (layer && isLayerHidden(layer)) setLayersHidden([layer], false);
}

function zoomToLayer(l: LayerData) {
	const mv = mapView.value;
	if (!mv || l.features.length === 0) return;
	reveal(l.id);
	mv.fitBounds(boundsOf(l.features.flatMap(pointsOf)), { padding: 100 });
}

const hoverFeature = (id: number | null) =>
	mapView.value?.setHoveredFeature(id);

function goTo(f: FeatureData) {
	const mv = mapView.value;
	if (!mv) return;
	reveal(f.layerId);
	mv.fitBounds(boundsOf(pointsOf(f)), { padding: 140 });
	openFeaturePopup(f);
}

function LayerForm(props: {
	initial?: LayerData;
	onDone: () => void;
	/** Without a cancel button the form is saved or left by other means. */
	showCancel?: boolean;
}) {
	const l = props.initial;
	const [name, setName] = useState(l?.name ?? "");
	const [color, setColor] = useState<Dye>(l?.color ?? "red");
	const [hidden, setHidden] = useState(l?.hiddenByDefault ?? false);
	const [priv, setPriv] = useState(l?.visibility === "private");
	const [style, setStyle] = useState<FeatureStyle>(l?.style ?? {});
	const [busy, setBusy] = useState(false);
	// Whoever creates a layer may make it private; afterwards that is up to its creator or a moderator.
	const canSetVisibility = !l || l.canManage;

	const submit = async (e: Event) => {
		e.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		const visibility = priv ? "private" : "public";
		let ok = false;
		try {
			ok = l
				? await updateLayer(l.id, {
						name: name.trim(),
						color,
						hiddenByDefault: hidden,
						visibility,
						style: cleanStyle(style),
					})
				: (await createLayer({
						name: name.trim(),
						color,
						hiddenByDefault: hidden,
						visibility,
						style: cleanStyle(style),
					})) !== null;
		} finally {
			setBusy(false);
		}
		if (ok) props.onDone();
	};

	return (
		<form class="layer-form" onSubmit={submit}>
			<input
				type="text"
				value={name}
				maxLength={MAX_NAME}
				placeholder="Layer name"
				aria-label="Layer name"
				onInput={(e) => setName(e.currentTarget.value)}
			/>
			<DyePicker
				label="Colour"
				value={color}
				onChange={(d) => d && setColor(d)}
			/>
			<details class="layer-style">
				<summary>Default style of lines and areas</summary>
				<p class="hint">
					Used by every line and area in this layer that does not set its own.
				</p>
				<StyleControls kind="layer" style={style} onChange={setStyle} />
			</details>
			<label class="check">
				<input
					type="checkbox"
					checked={hidden}
					onChange={(e) => setHidden(e.currentTarget.checked)}
				/>
				Hidden by default
			</label>
			<label
				class="check"
				title={
					canSetVisibility
						? undefined
						: "Only the layer's creator or a moderator can change this"
				}
			>
				<input
					type="checkbox"
					checked={priv}
					disabled={!canSetVisibility}
					onChange={(e) => setPriv(e.currentTarget.checked)}
				/>
				Private (only invited members and moderators)
			</label>
			<div class="group">
				<button
					type="submit"
					class="btn primary"
					disabled={busy || !name.trim()}
				>
					{l ? "Save" : "Create"}
				</button>
				{props.showCancel !== false && (
					<button type="button" class="btn" onClick={props.onDone}>
						Cancel
					</button>
				)}
			</div>
		</form>
	);
}

/** Picks a JSON file of features. `replace` swaps out everything in the layer instead of adding to it. */
function ImportButton(props: { layer: LayerData; replace: boolean }) {
	const { replace } = props;
	return (
		<label
			class="btn small"
			title={
				replace
					? "Delete every feature in this layer and use the ones in a JSON file"
					: "Add the features from a JSON file to this layer"
			}
		>
			{replace ? "Import (replace)" : "Import"}
			<input
				type="file"
				accept="application/json,.json"
				hidden
				onChange={async (e) => {
					const input = e.currentTarget;
					const file = input.files?.[0];
					input.value = "";
					if (!file) return;
					if (
						replace &&
						!confirm(
							"Replace ALL features in this layer with the imported ones?",
						)
					)
						return;
					let data: FeatureInput[];
					try {
						data = JSON.parse(await file.text());
					} catch {
						showNotice("That file is not valid JSON.", "error");
						return;
					}
					const out = await importFeatures(props.layer.id, data, replace);
					if (out) showNotice(`Imported ${out.imported} features.`);
				}}
			/>
		</label>
	);
}

/** Everything about a layer that is not its features: details, sharing, import and export, deletion. */
function LayerSettings(props: {
	layer: LayerData;
	editable: boolean;
	onBack: () => void;
}) {
	const { layer: l, editable, onBack } = props;
	return (
		<div class="layer-settings">
			<div class="settings-head">
				<button type="button" class="btn small" onClick={onBack}>
					← Back
				</button>
				<h3>Layer settings</h3>
			</div>

			{editable && (
				<section>
					<h4 class="section-title">Details</h4>
					<LayerForm initial={l} onDone={onBack} showCancel={false} />
				</section>
			)}

			{editable && l.visibility === "private" && l.canManage && (
				<section>
					<h4 class="section-title">Access</h4>
					<p class="hint">Who can see and edit this layer.</p>
					<button
						type="button"
						class="btn small"
						onClick={() => {
							layerSharingFor.value = { layerId: l.id, name: l.name };
						}}
					>
						Manage sharing
					</button>
				</section>
			)}

			<section>
				<h4 class="section-title">Data</h4>
				<p class="hint">
					Features are exchanged as JSON files, the same format Export writes.
				</p>
				<div class="settings-actions">
					<a
						class="btn small"
						href={`/api/layers/${l.id}/export`}
						download={`${l.name}.json`}
					>
						Export
					</a>
					{editable && <ImportButton layer={l} replace={false} />}
					{editable && <ImportButton layer={l} replace={true} />}
				</div>
				{editable && (
					<p class="hint">
						Import adds the file's features. Import (replace) deletes everything
						in this layer first.
					</p>
				)}
			</section>

			{editable && l.canManage && (
				<section class="danger-zone">
					<h4 class="section-title">Danger zone</h4>
					<button
						type="button"
						class="btn small danger"
						onClick={async () => {
							if (confirm(`Delete layer "${l.name}" and its features?`))
								await deleteLayer(l.id);
						}}
					>
						Delete layer
					</button>
				</section>
			)}
		</div>
	);
}

function LayerRow(props: {
	match: LayerMatch;
	filtering: boolean;
	/** Position among the layers, and how many there are; set when the layers can be reordered. */
	position?: { index: number; count: number };
	onMove: (from: number, to: number) => void;
}) {
	const l = props.match.layer;
	const features = props.match.features;
	const open = props.filtering || openLayers.value.has(l.id);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const editable = l.canEdit && canEditMap.value;
	const maxFeatures = currentMap.value?.limits.maxFeaturesPerLayer;
	const full = isLayerFull(l);
	const hidden = isLayerHidden(l);
	// A search shows only some of the features, so their order cannot be changed meanwhile.
	const featureOrder =
		editable && !props.filtering && l.features.length > 1
			? l.features.map((f) => f.id)
			: null;

	return (
		<li class={`layer ${open ? "open" : ""} ${hidden ? "hidden" : ""}`}>
			<div class="layer-head">
				{props.position && (
					<Grip
						id={`layer-${l.id}`}
						label={l.name}
						index={props.position.index}
						count={props.position.count}
						onMove={props.onMove}
					/>
				)}
				<input
					type="checkbox"
					checked={!hidden}
					aria-label={`Show ${l.name}`}
					onChange={() => toggleLayer(l)}
				/>
				<Banner dye={l.color} />
				<button
					type="button"
					class="plain layer-name"
					onClick={() => toggleOpen(l.id)}
					aria-expanded={open}
				>
					<span class="layer-title">{l.name}</span>
					{l.visibility === "private" && (
						<span class="badge" title="Only invited members and moderators">
							private
						</span>
					)}
					<span class="count">
						{props.filtering
							? `${features.length}/${l.features.length}`
							: l.features.length}
					</span>
					<span class="chevron" aria-hidden="true">
						{open ? "▼" : "▶"}
					</span>
				</button>
			</div>

			{open && (
				<div class="layer-body">
					{settingsOpen ? (
						<LayerSettings
							layer={l}
							editable={editable}
							onBack={() => setSettingsOpen(false)}
						/>
					) : (
						<div class="group layer-actions">
							{editable && (
								<button
									type="button"
									class="btn small primary"
									disabled={full}
									title={
										full
											? `This layer is full (${maxFeatures} features)`
											: undefined
									}
									onClick={() => {
										editor.value = { mode: "create", layerId: l.id };
									}}
								>
									Add feature
								</button>
							)}
							{l.features.length > 0 && (
								<button
									type="button"
									class="btn small"
									title="Move the map to show everything in this layer"
									onClick={() => zoomToLayer(l)}
								>
									Zoom to
								</button>
							)}
							{layersData.value.length > 1 && (
								<button
									type="button"
									class="btn small"
									title="Hide all the other layers"
									onClick={() => showOnlyLayer(l)}
								>
									Only this
								</button>
							)}
							<button
								type="button"
								class="btn small"
								title="Layer details, sharing, import and export"
								onClick={() => setSettingsOpen(true)}
							>
								Settings
							</button>
						</div>
					)}

					{!settingsOpen && (
						<ul class="features">
							{features.map((f, i) => (
								<li
									key={f.id}
									onMouseEnter={() => hoverFeature(f.id)}
									onMouseLeave={() => hoverFeature(null)}
								>
									{featureOrder && (
										<Grip
											id={`feature-${f.id}`}
											label={f.name || TYPE_LABEL[f.type]}
											index={i}
											count={featureOrder.length}
											onMove={(from, to) =>
												void reorderFeatures(
													l.id,
													moveItem(featureOrder, from, to),
												)
											}
										/>
									)}
									<button
										type="button"
										class="plain feature-link"
										onClick={() => goTo(f)}
									>
										<Banner dye={f.color ?? l.color} />
										<span class="type">{TYPE_LABEL[f.type]}</span>
										<span class="feature-name">
											{f.name || <em>unnamed</em>}
										</span>
									</button>
									{editable && (
										<span class="feature-actions">
											<button
												type="button"
												class="plain link"
												onClick={() => {
													editor.value = {
														mode: "edit",
														layerId: l.id,
														featureId: f.id,
													};
												}}
											>
												edit
											</button>
											<button
												type="button"
												class="plain link"
												onClick={async () => {
													if (confirm(`Delete "${featureTitle(f)}"?`))
														await deleteFeature(f.id);
												}}
											>
												delete
											</button>
										</span>
									)}
								</li>
							))}
							{features.length === 0 && <li class="muted">No features yet.</li>}
						</ul>
					)}
				</div>
			)}
		</li>
	);
}

export function LayerPanel() {
	const [creating, setCreating] = useState(false);
	const [query, setQuery] = useState("");
	const layers = layersData.value;
	const filtering = query.trim() !== "";
	const matches = searchLayers(layers, query);
	const canReorder = canEditMap.value && !filtering && layers.length > 1;
	const maxLayers = currentMap.value?.limits.maxLayersPerUser;
	const layersFull = layerLimitReached.value;
	const featureCount = matches.reduce((sum, m) => sum + m.features.length, 0);

	// The row's hover highlight must not outlive the list.
	useEffect(() => () => hoverFeature(null), []);

	return (
		<Panel title="Layers" onClose={() => (sidePanel.value = null)}>
			{canEditMap.value && (
				<div class="new-layer">
					{creating ? (
						<LayerForm onDone={() => setCreating(false)} />
					) : (
						<button
							type="button"
							class="btn wide"
							disabled={layersFull}
							title={
								layersFull
									? `You already have ${maxLayers} layers, the most one person may create`
									: undefined
							}
							onClick={() => setCreating(true)}
						>
							+ New layer
						</button>
					)}
				</div>
			)}
			{!user.value && <p class="muted">Log in to add or edit layers.</p>}
			{layers.length > 0 && (
				<div class="layer-tools">
					<input
						type="text"
						value={query}
						placeholder="Search layers and features"
						aria-label="Search layers and features"
						onInput={(e) => setQuery(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape" && query) {
								e.stopPropagation();
								setQuery("");
							}
						}}
					/>
					{layers.length > 1 && !filtering && (
						<div class="layer-bulk">
							<button
								type="button"
								class="plain link"
								onClick={() => setLayersHidden(layers, false)}
							>
								Show all
							</button>
							<button
								type="button"
								class="plain link"
								onClick={() => setLayersHidden(layers, true)}
							>
								Hide all
							</button>
						</div>
					)}
					{filtering && (
						<p class="hint">
							{featureCount} feature{featureCount === 1 ? "" : "s"} in{" "}
							{matches.length} layer{matches.length === 1 ? "" : "s"}
						</p>
					)}
				</div>
			)}
			<ul class="layers">
				{matches.map((m, i) => (
					<LayerRow
						key={m.layer.id}
						match={m}
						filtering={filtering}
						position={
							canReorder ? { index: i, count: matches.length } : undefined
						}
						onMove={(from, to) =>
							void reorderLayers(moveItem(layers, from, to).map((l) => l.id))
						}
					/>
				))}
			</ul>
			{layers.length === 0 && (
				<p class="muted">No layers in this dimension yet.</p>
			)}
			{layers.length > 0 && matches.length === 0 && (
				<p class="muted">Nothing matches “{query.trim()}”.</p>
			)}
		</Panel>
	);
}

import { DYE_HEX, DYES, type Dye } from "@aomc/shared/colors";
import { type FeatureInput, MAX_NAME } from "@aomc/shared/features";
import { useState } from "preact/hooks";
import { showNotice } from "../api";
import { mapView } from "../controller";
import { dyeLabel, featureTitle, pointsOf, TYPE_LABEL } from "../featureInfo";
import {
	createLayer,
	deleteFeature,
	deleteLayer,
	importFeatures,
	updateLayer,
} from "../layers";
import { boundsOf } from "../map/geometry";
import {
	canEditMap,
	editor,
	type FeatureData,
	isLayerHidden,
	type LayerData,
	layersData,
	popup,
	sidePanel,
	toggleLayer,
	user,
} from "../state";
import { layerSharingFor } from "./LayerSharing";
import { Panel } from "./Panel";

function goTo(f: FeatureData) {
	const mv = mapView.value;
	if (!mv) return;
	const b = boundsOf(pointsOf(f));
	mv.fitBounds(b, { padding: 140 });
	popup.value = {
		featureId: f.id,
		layerId: f.layerId,
		x: (b.minX + b.maxX) / 2 + 0.5,
		z: (b.minZ + b.maxZ) / 2 + 0.5,
	};
}

function LayerForm(props: { initial?: LayerData; onDone: () => void }) {
	const l = props.initial;
	const [name, setName] = useState(l?.name ?? "");
	const [color, setColor] = useState<Dye>(l?.color ?? "red");
	const [hidden, setHidden] = useState(l?.hiddenByDefault ?? false);
	const [priv, setPriv] = useState(l?.visibility === "private");
	const [busy, setBusy] = useState(false);

	const submit = async (e: Event) => {
		e.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		const visibility = priv ? "private" : "public";
		const ok = l
			? await updateLayer(l.id, {
					name: name.trim(),
					color,
					hiddenByDefault: hidden,
					visibility,
				})
			: (await createLayer({
					name: name.trim(),
					color,
					hiddenByDefault: hidden,
					visibility,
				})) !== null;
		setBusy(false);
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
			<span class="color-row">
				<span class="swatch" style={{ background: DYE_HEX[color] }} />
				<select
					value={color}
					aria-label="Colour"
					onChange={(e) => setColor(e.currentTarget.value as Dye)}
				>
					{DYES.map((d) => (
						<option key={d} value={d}>
							{dyeLabel(d)}
						</option>
					))}
				</select>
			</span>
			<label class="check">
				<input
					type="checkbox"
					checked={hidden}
					onChange={(e) => setHidden(e.currentTarget.checked)}
				/>
				Hidden by default
			</label>
			<label class="check">
				<input
					type="checkbox"
					checked={priv}
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
				<button type="button" class="btn" onClick={props.onDone}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function ImportButton(props: { layer: LayerData }) {
	const [replace, setReplace] = useState(false);
	return (
		<span class="import">
			<label class="btn file-btn">
				Import
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
			<label class="check small">
				<input
					type="checkbox"
					checked={replace}
					onChange={(e) => setReplace(e.currentTarget.checked)}
				/>
				replace
			</label>
		</span>
	);
}

function LayerRow(props: { layer: LayerData }) {
	const l = props.layer;
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const editable = l.canEdit && canEditMap.value;
	const hidden = isLayerHidden(l);

	return (
		<li class="layer">
			<div class="layer-head">
				<input
					type="checkbox"
					checked={!hidden}
					aria-label={`Show ${l.name}`}
					onChange={() => toggleLayer(l)}
				/>
				<span class="swatch" style={{ background: DYE_HEX[l.color] }} />
				<button
					type="button"
					class="plain layer-name"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
				>
					{l.visibility === "private" && <span title="Private layer">🔒 </span>}
					{l.name}
					<span class="count">{l.features.length}</span>
				</button>
			</div>

			{open && (
				<div class="layer-body">
					{editing ? (
						<LayerForm initial={l} onDone={() => setEditing(false)} />
					) : (
						<div class="group layer-actions">
							{editable && (
								<>
									<button
										type="button"
										class="btn"
										onClick={() => {
											editor.value = { mode: "create", layerId: l.id };
										}}
									>
										Add feature
									</button>
									<button
										type="button"
										class="btn"
										onClick={() => setEditing(true)}
									>
										Settings
									</button>
									{l.visibility === "private" && l.canManage && (
										<button
											type="button"
											class="btn"
											title="Who can see and edit this layer"
											onClick={() => {
												layerSharingFor.value = { layerId: l.id, name: l.name };
											}}
										>
											Sharing
										</button>
									)}
									<ImportButton layer={l} />
								</>
							)}
							<a
								class="btn"
								href={`/api/layers/${l.id}/export`}
								download={`${l.name}.json`}
							>
								Export
							</a>
							{editable && (
								<button
									type="button"
									class="btn danger"
									onClick={async () => {
										if (confirm(`Delete layer "${l.name}" and its features?`))
											await deleteLayer(l.id);
									}}
								>
									Delete
								</button>
							)}
						</div>
					)}

					<ul class="features">
						{l.features.map((f) => (
							<li key={f.id}>
								<button
									type="button"
									class="plain feature-link"
									onClick={() => goTo(f)}
								>
									<span class="type">{TYPE_LABEL[f.type]}</span>{" "}
									{f.name || <em>unnamed</em>}
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
						{l.features.length === 0 && <li class="muted">No features yet.</li>}
					</ul>
				</div>
			)}
		</li>
	);
}

export function LayerPanel() {
	const [creating, setCreating] = useState(false);
	const layers = layersData.value;
	return (
		<Panel title="Layers" onClose={() => (sidePanel.value = null)}>
			{canEditMap.value && (
				<div class="new-layer">
					{creating ? (
						<LayerForm onDone={() => setCreating(false)} />
					) : (
						<button type="button" class="btn" onClick={() => setCreating(true)}>
							+ New layer
						</button>
					)}
				</div>
			)}
			{!user.value && <p class="muted">Log in to add or edit layers.</p>}
			<ul class="layers">
				{layers.map((l) => (
					<LayerRow key={l.id} layer={l} />
				))}
			</ul>
			{layers.length === 0 && (
				<p class="muted">No layers in this dimension yet.</p>
			)}
		</Panel>
	);
}

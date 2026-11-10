import { DYE_HEX, DYES, type Dye } from "@aomc/shared/colors";
import type { Point } from "@aomc/shared/features";
import { useState } from "preact/hooks";
import { mapView } from "../controller";
import {
	createLayer,
	deleteFeature,
	deleteLayer,
	importFeatures,
	showNotice,
	updateLayer,
} from "../layers";
import { boundsOf } from "../map/geometry";
import {
	canEditMap,
	currentMap,
	editor,
	type FeatureData,
	isLayerHidden,
	type LayerData,
	layerPanelOpen,
	layersData,
	popup,
	toggleLayer,
	user,
} from "../state";

const TYPE_LABEL = { pin: "Pin", line: "Line", polygon: "Area" } as const;
const dyeLabel = (d: string) => d.replace("_", " ");

function goTo(f: FeatureData) {
	const mv = mapView.value;
	if (!mv) return;
	const pts =
		f.type === "pin" ? [f.geometry as Point] : (f.geometry as Point[]);
	const b = boundsOf(pts);
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
		const visibility = priv ? "private" : "inherit";
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
				maxLength={100}
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
						let data: unknown;
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
					class="layer-name"
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
									class="feature-link"
									onClick={() => goTo(f)}
								>
									<span class="type">{TYPE_LABEL[f.type]}</span>{" "}
									{f.name || <em>unnamed</em>}
								</button>
								{editable && (
									<span class="feature-actions">
										<button
											type="button"
											class="link"
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
											class="link"
											onClick={async () => {
												if (
													confirm(`Delete "${f.name || TYPE_LABEL[f.type]}"?`)
												)
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
	const role = currentMap.value?.role;
	return (
		<aside class="panel" aria-label="Layers">
			<header class="panel-head">
				<h2>Layers</h2>
				<button
					type="button"
					class="btn"
					aria-label="Close layers"
					onClick={() => (layerPanelOpen.value = false)}
				>
					×
				</button>
			</header>
			<div class="panel-body">
				{canEditMap.value && (
					<div class="new-layer">
						{creating ? (
							<LayerForm onDone={() => setCreating(false)} />
						) : (
							<button
								type="button"
								class="btn"
								onClick={() => setCreating(true)}
							>
								+ New layer
							</button>
						)}
					</div>
				)}
				{!user.value && <p class="muted">Log in to add or edit layers.</p>}
				{user.value && role === "viewer" && (
					<p class="muted">You have view-only access to this map.</p>
				)}
				<ul class="layers">
					{layers.map((l) => (
						<LayerRow key={l.id} layer={l} />
					))}
				</ul>
				{layers.length === 0 && (
					<p class="muted">No layers in this dimension yet.</p>
				)}
			</div>
		</aside>
	);
}

import type { Dye } from "@aomc/shared/colors";
import {
	cleanStyle,
	type FeatureInput,
	type FeatureStyle,
	type FeatureType,
	MAX_NAME,
	MAX_POPUP,
} from "@aomc/shared/features";
import { useEffect, useRef, useState } from "preact/hooks";
import { showNotice } from "../api";
import { pathsOf, TYPE_LABEL } from "../featureInfo";
import { createFeature, deleteFeature, updateFeature } from "../layers";
import { resolveStyle } from "../map/featureStyle";
import {
	draftLook,
	editor,
	isLayerFull,
	isLayerHidden,
	lastEditLayer,
	layersData,
	popup,
	setLayersHidden,
} from "../state";
import {
	type DrawState,
	drawing,
	drawnGeometry,
	drawReady,
	finishDraw,
	minPoints,
	resumeDraw,
	setDrawType,
	startDraw,
	stopDraw,
	undoPoint,
} from "../tools/draw";
import { DyePicker } from "./DyePicker";
import { Banner } from "./icons";
import { Panel } from "./Panel";
import { PointsList, ShapeStats } from "./PointsList";
import { StyleControls } from "./StyleControls";

const TYPES: FeatureType[] = ["pin", "line", "polygon"];

const closeEditor = () => {
	stopDraw();
	editor.value = null;
};

function drawHint(d: DrawState | null, type: FeatureType): string {
	const mode = d?.mode ?? "draw";
	const count = d?.points.length ?? 0;
	if (type === "pin")
		return mode === "placed"
			? "Drag the marker to move it, or type its coordinates."
			: "Click the map to place the pin.";
	if (type === "line") {
		if (mode === "placed")
			return "Drag a point to move it (onto another point to join them), or a + to add one. Click a point to draw on from it, which branches the line from the middle. Right-click a point to remove it.";
		if (count === 0)
			return "Click the map to start the line. Hold Shift to snap to straight lines.";
		if (d?.selected === null)
			return "Click a point to draw on from it, or the map to start a separate part.";
		return "Click to add points. Click another point to join it, which closes a loop, or the selected point (or press Enter or Esc) to stop, then click any point to branch from it. Hold Shift to snap to straight lines.";
	}
	if (mode === "placed")
		return "Drag a point to move it, or drag a + on a segment to add one. Right-click a point to remove it.";
	const need = minPoints(type);
	if (count < need)
		return `Click the map to add points (${count}/${need} minimum). Hold Shift to snap to straight lines.`;
	return "Click to add more points. Click the first point or press Enter or Esc to close the area.";
}

/** Side panel for creating or editing one feature. Geometry is placed on the map with the draw tool. */
export function FeatureEditor() {
	const target = editor.value;
	const layer = layersData.value.find((l) => l.id === target?.layerId);
	const existing =
		target?.mode === "edit"
			? layer?.features.find((f) => f.id === target.featureId)
			: undefined;

	const shape = target?.mode === "create" ? target.shape : undefined;
	// When editing, the layer the feature is going to; `layer` stays the one it is in now.
	const [destId, setDestId] = useState(target?.layerId);
	const dest =
		target?.mode === "edit"
			? (layersData.value.find((l) => l.id === destId) ?? layer)
			: layer;

	const [type, setType] = useState<FeatureType>(
		existing?.type ?? shape?.type ?? "pin",
	);
	const [name, setName] = useState(existing?.name ?? "");
	const [text, setText] = useState(existing?.popup ?? "");
	const [color, setColor] = useState<Dye | null>(existing?.color ?? null);
	const [style, setStyle] = useState<FeatureStyle>(existing?.style ?? {});
	const [saving, setSaving] = useState(false);
	// The revision the edit is based on; moves forward only when a conflict is reported.
	const [baseRevision, setBaseRevision] = useState<number | undefined>(
		existing?.revisionId,
	);
	const popupField = useRef<HTMLTextAreaElement>(null);

	const cancelEditing = () => {
		editor.value = null;
	};

	useEffect(() => {
		const at = target?.mode === "create" ? target.at : undefined;
		startDraw(
			existing?.type ?? shape?.type ?? "pin",
			existing ? pathsOf(existing) : shape ? shape.paths : at ? [[at]] : [],
			cancelEditing,
		);
		return () => stopDraw();
	}, []);

	// What the map previews while editing.
	useEffect(() => {
		const own = type === "pin" ? null : cleanStyle(style);
		draftLook.value = {
			color,
			style: own,
			smooth:
				type !== "pin" &&
				resolveStyle(own, type === "polygon", dest?.style).smooth,
		};
		return () => {
			draftLook.value = null;
		};
	}, [color, style, type, dest?.style]);

	if (!target || !layer) return null;
	const d = drawing.value;
	const points = d?.points ?? [];
	const ready = !!d && drawReady(d);
	// A new feature can go to any layer that can take it.
	const layers = layersData.value.filter(
		(l) => l.canEdit && (l.id === layer.id || !isLayerFull(l)),
	);
	const moving = target.mode === "edit" && dest && dest.id !== layer.id;

	const changeType = (next: FeatureType) => {
		setType(next);
		setDrawType(next);
	};

	/** `another`: stay in the editor with a blank feature (same type and colour) for the next one. */
	const save = async (another = false) => {
		if (!ready || saving) return;
		if (!d) return;
		const input = {
			name: name.trim(),
			popup: text,
			color,
			type,
			style: type === "pin" ? null : cleanStyle(style),
			geometry: drawnGeometry(d),
		} as FeatureInput;
		setSaving(true);
		let saved = false;
		try {
			if (target.mode === "create") {
				saved = (await createFeature(layer.id, input)) !== null;
			} else {
				const out = await updateFeature(
					target.featureId,
					moving && dest ? { ...input, layerId: dest.id } : input,
					baseRevision,
				);
				saved = out.saved;
				if (!out.saved && out.conflict)
					setBaseRevision(out.conflict.revisionId);
			}
		} finally {
			setSaving(false);
		}
		if (!saved) return;
		const finalLayer = moving && dest ? dest : layer;
		lastEditLayer.value = finalLayer.id;
		if (finalLayer !== layer && isLayerHidden(finalLayer))
			setLayersHidden([finalLayer], false);
		if (another && target.mode === "create") {
			setName("");
			setText("");
			startDraw(type, [], cancelEditing);
			showNotice("Feature added.");
			return;
		}
		closeEditor();
		popup.value = null;
	};

	/** Puts the selected popup text between `before` and `after` (or a placeholder if nothing is selected). */
	const wrapSelection = (
		before: string,
		after: string,
		placeholder: string,
	) => {
		const el = popupField.current;
		if (!el) return;
		const from = el.selectionStart;
		const to = el.selectionEnd;
		const selected = text.slice(from, to) || placeholder;
		const next =
			text.slice(0, from) + before + selected + after + text.slice(to);
		if (next.length > MAX_POPUP) return;
		setText(next);
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(
				from + before.length,
				from + before.length + selected.length,
			);
		});
	};

	const remove = async () => {
		if (target.mode !== "edit" || !confirm("Delete this feature?")) return;
		if (await deleteFeature(target.featureId)) closeEditor();
	};

	return (
		<Panel
			title={target.mode === "create" ? "New feature" : "Edit feature"}
			onClose={closeEditor}
			closeText="Cancel"
			class="editor"
			footer={
				<>
					{target.mode === "edit" && (
						<button type="button" class="btn danger" onClick={remove}>
							Delete
						</button>
					)}
					<span class="spacer" />
					{target.mode === "create" && (
						<button
							type="button"
							class="btn"
							disabled={!ready || saving}
							title="Save this feature and start a new one in the same layer"
							onClick={() => save(true)}
						>
							Save & add another
						</button>
					)}
					<button
						type="button"
						class="btn primary"
						disabled={!ready || saving}
						onClick={() => save()}
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</>
			}
		>
			{layers.length > 1 ? (
				<label class="field editor-layer-pick">
					<span class="label">Layer</span>
					<select
						value={dest?.id ?? layer.id}
						onChange={(e) => {
							const next = layers.find(
								(l) => l.id === Number(e.currentTarget.value),
							);
							if (!next) return;
							if (target.mode === "edit") {
								setDestId(next.id);
								return;
							}
							if (isLayerHidden(next)) setLayersHidden([next], false);
							editor.value = { ...target, layerId: next.id };
						}}
					>
						{layers.map((l) => (
							<option key={l.id} value={l.id}>
								{l.name}
							</option>
						))}
					</select>
				</label>
			) : (
				<p class="editor-layer">
					<Banner dye={layer.color} /> {layer.name}
				</p>
			)}

			<div class="field">
				<span class="label">Type</span>
				<div class="segmented">
					{TYPES.map((t) => (
						<button
							key={t}
							type="button"
							class={`btn ${type === t ? "active" : ""}`}
							aria-pressed={type === t}
							onClick={() => changeType(t)}
						>
							{TYPE_LABEL[t]}
						</button>
					))}
				</div>
			</div>

			<div class="field draw-controls">
				<span class="label">Location</span>
				<p class="hint">{drawHint(d, type)}</p>
				<ShapeStats />
				<div class="group">
					{d?.mode === "draw" && type !== "pin" && (
						<button
							type="button"
							class="btn small"
							disabled={!ready}
							onClick={() => finishDraw()}
						>
							Finish
						</button>
					)}
					{d?.mode === "placed" && (
						<button type="button" class="btn small" onClick={resumeDraw}>
							{type === "pin" ? "Place again" : "Add points"}
						</button>
					)}
					{type !== "pin" && points.length > 0 && (
						<button type="button" class="btn small" onClick={undoPoint}>
							{d?.selected != null
								? `Remove point ${d.selected + 1}`
								: "Undo last"}
						</button>
					)}
				</div>
				<PointsList />
			</div>

			<label class="field">
				<span class="label">Name</span>
				<input
					type="text"
					value={name}
					maxLength={MAX_NAME}
					onInput={(e) => setName(e.currentTarget.value)}
					placeholder="Shown on hover"
				/>
			</label>

			<div class="field">
				<span class="label">
					Popup{" "}
					<small>
						({text.length}/{MAX_POPUP})
					</small>
				</span>
				<div class="format-bar">
					<button
						type="button"
						class="btn small"
						title="Bold (Ctrl+B)"
						onClick={() => wrapSelection("**", "**", "bold text")}
					>
						<b>B</b>
					</button>
					<button
						type="button"
						class="btn small"
						title="Link: select the text first, then put the address in the brackets"
						onClick={() => wrapSelection("[", "](https://)", "link text")}
					>
						Link
					</button>
				</div>
				<textarea
					ref={popupField}
					rows={4}
					value={text}
					maxLength={MAX_POPUP}
					aria-label="Popup text"
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={(e) => {
						if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
							e.preventDefault();
							wrapSelection("**", "**", "bold text");
						}
					}}
					placeholder="**bold**, [links](https://example.com) and line breaks"
				/>
			</div>

			{type !== "pin" && (
				<div class="field">
					<span class="label">Style</span>
					<StyleControls
						kind={type}
						style={style}
						inherited={dest?.style ?? layer.style}
						onChange={setStyle}
					/>
				</div>
			)}

			<div class="field">
				<span class="label">Colour</span>
				<DyePicker
					label="Colour"
					value={color}
					fallback={dest?.color ?? layer.color}
					onChange={setColor}
				/>
			</div>
		</Panel>
	);
}

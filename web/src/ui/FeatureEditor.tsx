import type { Dye } from "@aomc/shared/colors";
import {
	type FeatureInput,
	type FeatureType,
	MAX_NAME,
	MAX_POPUP,
} from "@aomc/shared/features";
import { useEffect, useState } from "preact/hooks";
import { showNotice } from "../api";
import { pointsOf, TYPE_LABEL } from "../featureInfo";
import { createFeature, deleteFeature, updateFeature } from "../layers";
import { editor, layersData, popup } from "../state";
import {
	drawing,
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

const TYPES: FeatureType[] = ["pin", "line", "polygon"];

const closeEditor = () => {
	stopDraw();
	editor.value = null;
};

function drawHint(
	type: FeatureType,
	count: number,
	mode: "draw" | "placed",
): string {
	if (mode === "placed")
		return type === "pin"
			? "Drag the marker to move it."
			: `${count} points. Drag a point to move it.`;
	if (type === "pin") return "Click the map to place the pin.";
	const need = minPoints(type);
	return count < need
		? `Click the map to add points (${count}/${need} minimum).`
		: `${count} points. Click to add more, then Finish (or press Enter).`;
}

/** Side panel for creating or editing one feature. Geometry is placed on the map with the draw tool. */
export function FeatureEditor() {
	const target = editor.value;
	const layer = layersData.value.find((l) => l.id === target?.layerId);
	const existing =
		target?.mode === "edit"
			? layer?.features.find((f) => f.id === target.featureId)
			: undefined;

	const [type, setType] = useState<FeatureType>(existing?.type ?? "pin");
	const [name, setName] = useState(existing?.name ?? "");
	const [text, setText] = useState(existing?.popup ?? "");
	const [color, setColor] = useState<Dye | null>(existing?.color ?? null);
	const [saving, setSaving] = useState(false);

	const cancelEditing = () => {
		editor.value = null;
	};

	useEffect(() => {
		startDraw(
			existing?.type ?? "pin",
			existing ? pointsOf(existing) : [],
			cancelEditing,
		);
		return () => stopDraw();
	}, []);

	if (!target || !layer) return null;
	const d = drawing.value;
	const points = d?.points ?? [];
	const ready = points.length >= minPoints(type);

	const changeType = (next: FeatureType) => {
		setType(next);
		setDrawType(next);
	};

	/** `another`: stay in the editor with a blank feature (same type and colour) for the next one. */
	const save = async (another = false) => {
		if (!ready || saving) return;
		const common = { name: name.trim(), popup: text, color };
		const [first] = points;
		const input: FeatureInput | null =
			type !== "pin"
				? { ...common, type, geometry: points }
				: first
					? { ...common, type, geometry: first }
					: null;
		if (!input) return;
		setSaving(true);
		const saved =
			target.mode === "create"
				? await createFeature(layer.id, input)
				: await updateFeature(target.featureId, input);
		setSaving(false);
		if (!saved) return;
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
			<p class="editor-layer">
				<Banner dye={layer.color} /> {layer.name}
			</p>

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
				<p class="hint">{drawHint(type, points.length, d?.mode ?? "draw")}</p>
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
							Undo last
						</button>
					)}
				</div>
				{type === "pin" && points[0] && (
					<p class="hint">
						x {points[0][0]}, z {points[0][1]}
					</p>
				)}
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

			<label class="field">
				<span class="label">
					Popup{" "}
					<small>
						({text.length}/{MAX_POPUP})
					</small>
				</span>
				<textarea
					rows={4}
					value={text}
					maxLength={MAX_POPUP}
					onInput={(e) => setText(e.currentTarget.value)}
					placeholder="**bold**, [links](https://example.com) and line breaks"
				/>
			</label>

			<div class="field">
				<span class="label">Colour</span>
				<DyePicker
					label="Colour"
					value={color}
					fallback={layer.color}
					onChange={setColor}
				/>
			</div>
		</Panel>
	);
}

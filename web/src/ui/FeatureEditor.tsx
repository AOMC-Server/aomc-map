import { DYE_HEX, DYES, type Dye } from "@aomc/shared/colors";
import {
	type FeatureType,
	MAX_NAME,
	MAX_POPUP,
	type Point,
} from "@aomc/shared/features";
import { useEffect, useState } from "preact/hooks";
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

const TYPES: { type: FeatureType; label: string }[] = [
	{ type: "pin", label: "Pin" },
	{ type: "line", label: "Line" },
	{ type: "polygon", label: "Area" },
];

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

	useEffect(() => {
		const initial: Point[] = !existing
			? []
			: existing.type === "pin"
				? [existing.geometry as Point]
				: (existing.geometry as Point[]);
		startDraw(existing?.type ?? "pin", initial, () => {
			editor.value = null;
		});
		return () => stopDraw();
		// The session is started once per open editor.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (!target || !layer) return null;
	const d = drawing.value;
	const points = d?.points ?? [];
	const ready = points.length >= minPoints(type);

	const changeType = (next: FeatureType) => {
		setType(next);
		setDrawType(next);
	};

	const save = async () => {
		if (!ready || saving) return;
		setSaving(true);
		const input = {
			type,
			name: name.trim(),
			popup: text,
			color,
			geometry: type === "pin" ? (points[0] as Point) : points,
		} as Parameters<typeof createFeature>[1];
		const saved =
			target.mode === "create"
				? await createFeature(layer.id, input)
				: await updateFeature(target.featureId, input);
		setSaving(false);
		if (!saved) return;
		closeEditor();
		popup.value = null;
	};

	const remove = async () => {
		if (target.mode !== "edit" || !confirm("Delete this feature?")) return;
		if (await deleteFeature(target.featureId)) closeEditor();
	};

	return (
		<aside class="panel editor" aria-label="Feature editor">
			<header class="panel-head">
				<h2>{target.mode === "create" ? "New feature" : "Edit feature"}</h2>
				<button type="button" class="btn" onClick={closeEditor}>
					Cancel
				</button>
			</header>
			<div class="panel-body">
				<p class="muted">Layer: {layer.name}</p>

				<div class="field">
					<span class="label">Type</span>
					<div class="group">
						{TYPES.map((t) => (
							<button
								key={t.type}
								type="button"
								class={`btn ${type === t.type ? "active" : ""}`}
								aria-pressed={type === t.type}
								onClick={() => changeType(t.type)}
							>
								{t.label}
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
								class="btn"
								disabled={!ready}
								onClick={() => finishDraw()}
							>
								Finish
							</button>
						)}
						{d?.mode === "placed" && (
							<button type="button" class="btn" onClick={resumeDraw}>
								{type === "pin" ? "Place again" : "Add points"}
							</button>
						)}
						{type !== "pin" && points.length > 0 && (
							<button type="button" class="btn" onClick={undoPoint}>
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

				<label class="field">
					<span class="label">Colour</span>
					<span class="color-row">
						<span
							class="swatch"
							style={{ background: DYE_HEX[color ?? layer.color] }}
						/>
						<select
							value={color ?? ""}
							onChange={(e) =>
								setColor((e.currentTarget.value || null) as Dye | null)
							}
						>
							<option value="">
								Layer default ({layer.color.replace("_", " ")})
							</option>
							{DYES.map((dye) => (
								<option key={dye} value={dye}>
									{dye.replace("_", " ")}
								</option>
							))}
						</select>
					</span>
				</label>
			</div>
			<footer class="panel-foot">
				{target.mode === "edit" && (
					<button type="button" class="btn danger" onClick={remove}>
						Delete
					</button>
				)}
				<span class="spacer" />
				<button
					type="button"
					class="btn primary"
					disabled={!ready || saving}
					onClick={save}
				>
					{saving ? "Saving…" : "Save"}
				</button>
			</footer>
		</aside>
	);
}

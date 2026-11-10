import { selectDimension, selectMap } from "../controller";
import {
	activeTool,
	currentMap,
	dimSlug,
	layerPanelOpen,
	maps,
	type Tool,
	visibleDimensions,
} from "../state";
import { LoginButton } from "./LoginButton";

function ToolButton(props: {
	tool: Exclude<Tool, "none">;
	label: string;
	title: string;
}) {
	const active = activeTool.value === props.tool;
	return (
		<button
			type="button"
			class={`btn ${active ? "active" : ""}`}
			title={props.title}
			aria-pressed={active}
			onClick={() => {
				activeTool.value = active ? "none" : props.tool;
			}}
		>
			{props.label}
		</button>
	);
}

export function Toolbar() {
	const detail = currentMap.value;
	const dims = visibleDimensions.value;
	return (
		<header class="toolbar">
			<select
				class="map-select"
				aria-label="Map"
				value={detail?.map.slug}
				onChange={(e) =>
					selectMap(e.currentTarget.value, { dim: dimSlug.value })
				}
			>
				{maps.value.map((m) => (
					<option key={m.slug} value={m.slug}>
						{m.name}
						{m.visibility === "private" ? " (private)" : ""}
					</option>
				))}
			</select>

			<div class="group" role="tablist" aria-label="Dimension">
				{dims.map((d) => (
					<button
						key={d.slug}
						type="button"
						role="tab"
						aria-selected={d.slug === dimSlug.value}
						class={`btn ${d.slug === dimSlug.value ? "active" : ""}`}
						onClick={() => selectDimension(d.slug)}
					>
						{d.name}
					</button>
				))}
			</div>

			<button
				type="button"
				class={`btn ${layerPanelOpen.value ? "active" : ""}`}
				aria-pressed={layerPanelOpen.value}
				onClick={() => {
					layerPanelOpen.value = !layerPanelOpen.value;
				}}
			>
				Layers
			</button>

			<div class="group">
				<ToolButton
					tool="measure"
					label="Measure"
					title="Click two points to measure (Esc clears)"
				/>
				<ToolButton
					tool="copy"
					label="Copy coords"
					title="Click to copy coordinates to the clipboard"
				/>
			</div>

			<div class="spacer" />
			<LoginButton />
		</header>
	);
}

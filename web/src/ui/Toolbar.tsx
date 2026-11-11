import { useEffect, useRef } from "preact/hooks";
import { selectDimension, selectMap } from "../controller";
import {
	activeTool,
	canAdminister,
	currentMap,
	dimSlug,
	historyPanelOpen,
	layerPanelOpen,
	mapPanelOpen,
	maps,
	rev,
	type Tool,
	toggleSidePanel,
	visibleDimensions,
} from "../state";
import { uploadBusy, uploadOpen } from "../upload";
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
	const ref = useRef<HTMLElement>(null);

	// The toolbar wraps on narrow screens; panels and banners position themselves below it.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const publish = () =>
			document.documentElement.style.setProperty(
				"--toolbar-h",
				`${el.offsetHeight}px`,
			);
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<header class="toolbar" ref={ref}>
			{/* Maps are not user-creatable, so most installs have just one; only show a picker for several. */}
			{maps.value.length > 1 ? (
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
			) : (
				<span class="map-title">{detail?.map.name}</span>
			)}

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
				onClick={() => toggleSidePanel("layers")}
			>
				Layers
			</button>

			<button
				type="button"
				class={`btn ${historyPanelOpen.value || rev.value !== null ? "active" : ""}`}
				aria-pressed={historyPanelOpen.value}
				onClick={() => toggleSidePanel("history")}
			>
				History
			</button>

			{canAdminister.value && (
				<button
					type="button"
					class={`btn ${mapPanelOpen.value ? "active" : ""}`}
					aria-pressed={mapPanelOpen.value}
					title="Settings, dimensions, members and invite links"
					onClick={() => toggleSidePanel("map")}
				>
					Manage
				</button>
			)}

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
			<button
				type="button"
				class={`btn ${uploadBusy() ? "active" : ""}`}
				title="Upload Xaero's World Map exports"
				onClick={() => {
					uploadOpen.value = true;
				}}
			>
				{uploadBusy() ? "Uploading…" : "Upload"}
			</button>
			<LoginButton />
		</header>
	);
}

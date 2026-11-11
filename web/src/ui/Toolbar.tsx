import { useEffect, useRef } from "preact/hooks";
import { selectDimension } from "../controller";
import {
	activeTool,
	currentMap,
	dimSlug,
	isModerator,
	rev,
	type SidePanelName,
	sidePanel,
	type Tool,
	visibleDimensions,
} from "../state";
import { uploadBusy, uploadOpen } from "../upload";
import { LoginButton } from "./LoginButton";

/** One side panel at a time; opening the one that is already open closes it. */
const toggle = (name: SidePanelName) => {
	sidePanel.value = sidePanel.value === name ? null : name;
};

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
			<span class="map-title">{detail?.map.name}</span>

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
				class={`btn ${sidePanel.value === "layers" ? "active" : ""}`}
				aria-pressed={sidePanel.value === "layers"}
				onClick={() => toggle("layers")}
			>
				Layers
			</button>

			<button
				type="button"
				class={`btn ${sidePanel.value === "history" || rev.value !== null ? "active" : ""}`}
				aria-pressed={sidePanel.value === "history"}
				onClick={() => toggle("history")}
			>
				History
			</button>

			{isModerator.value && (
				<a
					class="btn"
					href="/manage"
					title="Settings, dimensions, members and invite links"
				>
					Manage
				</a>
			)}

			<div class="group">
				<ToolButton
					tool="measure"
					label="Measure"
					title="Click two points to measure (Esc clears)"
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

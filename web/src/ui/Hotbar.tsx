import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { isTyping } from "../map/input";
import {
	activeTool,
	isModerator,
	rev,
	type SidePanelName,
	sidePanel,
} from "../state";
import { uploadBusy, uploadOpen, uploadState } from "../upload";
import { type IconName, PixelIcon } from "./icons";

/** One side panel at a time; opening the one that is already open closes it. */
const toggle = (name: SidePanelName) => {
	sidePanel.value = sidePanel.value === name ? null : name;
};

/** Upload progress from 0 to 1, or null when it can't be known yet. */
function uploadProgress(): number | null {
	const s = uploadState.value;
	if (s.phase === "uploading") return s.percent / 100;
	if (s.phase === "processing" && s.total) return (s.done ?? 0) / s.total;
	return null;
}

type Slot = {
	key: string;
	icon: IconName;
	label: string;
	hint: string;
	active: boolean;
	/** Selected, but shown in yellow: something is off about the current view. */
	warn?: boolean;
	href?: string;
	run?: () => void;
	extra?: ComponentChildren;
};

function DurabilityBar(props: { value: number | null }) {
	const v = props.value;
	// Like an item's durability: green when full, through yellow, to red.
	const hue = v === null ? 120 : Math.round(v * 120);
	return (
		<span class={`durability ${v === null ? "indeterminate" : ""}`}>
			<span
				style={{
					width: `${Math.round((v ?? 1) * 100)}%`,
					background: `hsl(${hue} 100% 50%)`,
				}}
			/>
		</span>
	);
}

/** The tools and panels, as inventory slots along the bottom; number keys select them. */
export function Hotbar() {
	const busy = uploadBusy();
	const slots: Slot[] = [
		{
			key: "1",
			icon: "banner",
			label: "Layers",
			hint: "Markers, lines and areas",
			active: sidePanel.value === "layers",
			run: () => toggle("layers"),
		},
		{
			key: "2",
			icon: "clock",
			label: "History",
			hint: "Earlier versions of the map",
			active: sidePanel.value === "history" || rev.value !== null,
			// Looking at an old version with the history closed: remind that it is not the latest.
			warn: sidePanel.value !== "history" && rev.value !== null,
			run: () => toggle("history"),
		},
		{
			key: "3",
			icon: "compass",
			label: "Measure",
			hint: "Click points to measure a path (Esc clears)",
			active: activeTool.value === "measure",
			run: () => {
				activeTool.value = activeTool.value === "measure" ? "none" : "measure";
			},
		},
		{
			key: "4",
			icon: "upload",
			label: busy ? "Uploading…" : "Upload",
			hint: "Add Xaero's World Map exports",
			active: uploadOpen.value,
			run: () => {
				uploadOpen.value = true;
			},
			extra: busy && <DurabilityBar value={uploadProgress()} />,
		},
	];
	if (isModerator.value)
		slots.push({
			key: "5",
			icon: "command",
			label: "Manage",
			hint: "Settings, dimensions, members and invites",
			active: false,
			href: "/manage",
		});

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
			if (document.querySelector(".modal-backdrop")) return;
			const slot = slots.find((s) => s.key === e.key);
			if (!slot) return;
			e.preventDefault();
			if (slot.href) location.href = slot.href;
			else slot.run?.();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<nav class="hotbar dock" aria-label="Tools">
			{slots.map((s) => {
				const content = (
					<>
						<PixelIcon name={s.icon} />
						{s.extra}
						<span class="slot-tip" aria-hidden="true">
							<span class="tip-title">{s.label}</span>
							<span class="tip-line">{s.hint}</span>
							<span class="tip-key">Key: {s.key}</span>
						</span>
					</>
				);
				const cls = `hotbar-slot ${s.active ? "selected" : ""} ${s.warn ? "warn" : ""}`;
				return s.href ? (
					<a key={s.key} class={cls} href={s.href} aria-label={s.label}>
						{content}
					</a>
				) : (
					<button
						key={s.key}
						type="button"
						class={cls}
						aria-label={s.label}
						aria-pressed={s.active}
						onClick={s.run}
					>
						{content}
					</button>
				);
			})}
		</nav>
	);
}

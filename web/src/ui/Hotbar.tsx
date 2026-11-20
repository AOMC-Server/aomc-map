import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
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
import { shareOpen } from "./ShareDialog";

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
	/** On small screens only the essentials are in the bar; the rest is behind the "…" slot. */
	secondary?: boolean;
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
			icon: "layers",
			label: "Layers",
			hint: "Markers, lines and areas",
			active: sidePanel.value === "layers",
			run: () => toggle("layers"),
		},
		{
			key: "2",
			secondary: true,
			icon: "history",
			label: "History",
			hint: "Earlier versions of the map",
			active: sidePanel.value === "history" || rev.value !== null,
			// Looking at an old version with the history closed: remind that it is not the latest.
			warn: sidePanel.value !== "history" && rev.value !== null,
			run: () => toggle("history"),
		},
		{
			key: "3",
			icon: "measure",
			label: "Measure",
			hint: "Click points to measure a path (Esc stops, then clears)",
			active: activeTool.value === "measure",
			run: () => {
				activeTool.value = activeTool.value === "measure" ? "none" : "measure";
			},
		},
		{
			key: "4",
			secondary: true,
			icon: "upload",
			label: busy ? "Uploading…" : "Upload",
			hint: "Add Xaero's World Map exports",
			active: uploadOpen.value,
			run: () => {
				uploadOpen.value = true;
			},
			extra: busy && <DurabilityBar value={uploadProgress()} />,
		},
		{
			key: "5",
			secondary: true,
			icon: "share",
			label: "Share",
			hint: "A short link to this place, zoom and layers",
			active: shareOpen.value,
			run: () => {
				shareOpen.value = true;
			},
		},
		{
			key: "6",
			secondary: true,
			icon: "files",
			label: "Files",
			hint: "Downloads such as Voxy data and Xaero presets",
			active: false,
			href: "/files/",
		},
	];
	if (isModerator.value)
		slots.push({
			key: "7",
			secondary: true,
			icon: "manage",
			label: "Manage",
			hint: "Settings, dimensions, members and invites",
			active: false,
			href: "/manage",
		});

	// On small screens the position readout sits beside the hotbar and needs to know its width.
	const ref = useRef<HTMLElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const publish = () =>
			document.documentElement.style.setProperty(
				"--hotbar-w",
				`${el.offsetWidth}px`,
			);
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

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

	const [moreOpen, setMoreOpen] = useState(false);
	useEffect(() => {
		if (!moreOpen) return;
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setMoreOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMoreOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [moreOpen]);

	const hidden = slots.filter((s) => s.secondary);
	// Something behind "…" wants attention: an old version is shown, or an upload is running.
	const moreWarn = hidden.some((s) => s.warn);
	const moreBusy = hidden.some((s) => s.extra);

	return (
		<nav class="hotbar dock" aria-label="Tools" ref={ref}>
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
				const cls = `hotbar-slot ${s.active ? "selected" : ""} ${s.warn ? "warn" : ""} ${s.secondary ? "secondary" : ""}`;
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
			<button
				type="button"
				class={`hotbar-slot hotbar-more ${moreOpen ? "selected" : ""} ${moreWarn ? "warn selected" : ""}`}
				aria-label="More tools"
				aria-haspopup="menu"
				aria-expanded={moreOpen}
				onClick={() => setMoreOpen(!moreOpen)}
			>
				<PixelIcon name="more" />
				{moreBusy && <span class="more-dot" />}
			</button>
			{moreOpen && (
				<div class="hotbar-menu dock" role="menu">
					{hidden.map((s) => {
						const content = (
							<>
								<PixelIcon name={s.icon} size={24} />
								<span class="hotbar-menu-label">{s.label}</span>
								{s.extra}
							</>
						);
						const cls = `hotbar-menu-item ${s.active ? "selected" : ""} ${s.warn ? "warn" : ""}`;
						return s.href ? (
							<a key={s.key} class={cls} role="menuitem" href={s.href}>
								{content}
							</a>
						) : (
							<button
								key={s.key}
								type="button"
								class={cls}
								role="menuitem"
								onClick={() => {
									setMoreOpen(false);
									s.run?.();
								}}
							>
								{content}
							</button>
						);
					})}
				</div>
			)}
		</nav>
	);
}

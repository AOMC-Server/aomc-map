import type { Dye } from "@aomc/shared/colors";
import { MAX_NAME } from "@aomc/shared/features";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { mapView } from "../controller";
import { createLayer } from "../layers";
import {
	activeTool,
	canEditMap,
	contextMenu,
	editor,
	isLayerFull,
	isLayerHidden,
	layerLimitReached,
	layersData,
	popup,
	setLayersHidden,
	view,
} from "../state";
import { stopDraw } from "../tools/draw";
import { measureFrom } from "../tools/measure";
import { DyePicker } from "./DyePicker";
import { Banner } from "./icons";
import { copyText } from "./shareCommon";

/** Space kept between the menu and the edges of the map. */
const MARGIN = 8;

const close = () => {
	contextMenu.value = null;
};

/** Opens the feature editor with a pin already placed on the block. */
function addPin(layerId: number, x: number, z: number) {
	const layer = layersData.value.find((l) => l.id === layerId);
	if (layer && isLayerHidden(layer)) setLayersHidden([layer], false);
	close();
	popup.value = null;
	editor.value = { mode: "create", layerId, at: [x, z] };
}

/** Up and Down move between the items of the menu, like a native one. */
function moveFocus(menu: HTMLElement, step: 1 | -1) {
	const items = [
		...menu.querySelectorAll<HTMLButtonElement>("button.menu-item:enabled"),
	];
	if (items.length === 0) return;
	const at = items.indexOf(document.activeElement as HTMLButtonElement);
	const next =
		at < 0
			? step > 0
				? 0
				: items.length - 1
			: (at + step + items.length) % items.length;
	items[next]?.focus();
}

function NewLayerForm(props: { x: number; z: number; onBack: () => void }) {
	const [name, setName] = useState("");
	const [color, setColor] = useState<Dye>("red");
	const [busy, setBusy] = useState(false);

	const submit = async (e: Event) => {
		e.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		try {
			const layer = await createLayer({
				name: name.trim(),
				color,
				hiddenByDefault: false,
				visibility: "public",
			});
			if (layer) addPin(layer.id, props.x, props.z);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form class="menu-form" onSubmit={submit}>
			<input
				type="text"
				value={name}
				maxLength={MAX_NAME}
				placeholder="Layer name"
				aria-label="Layer name"
				// biome-ignore lint/a11y/noAutofocus: the form was opened to type this name
				autoFocus
				onInput={(e) => setName(e.currentTarget.value)}
			/>
			<DyePicker
				label="Colour"
				value={color}
				onChange={(d) => d && setColor(d)}
			/>
			<p class="hint">
				Public and shown by default; change that in its settings.
			</p>
			<div class="group">
				<button
					type="submit"
					class="btn small primary"
					disabled={busy || !name.trim()}
				>
					{busy ? "Creating…" : "Create and add pin"}
				</button>
				<button type="button" class="btn small" onClick={props.onBack}>
					Back
				</button>
			</div>
		</form>
	);
}

/** The map's right-click (or long press) menu: copy the coordinates, measure, or drop a pin. */
export function ContextMenu() {
	const target = contextMenu.value;
	const mv = mapView.value;
	view.value; // re-render when the camera moves, to stay on the clicked spot
	const ref = useRef<HTMLDivElement>(null);
	const [page, setPage] = useState<"main" | "layers" | "new">("main");

	// Each new menu starts on its first page.
	useLayoutEffect(() => setPage("main"), [target]);

	useEffect(() => {
		if (!target) return;
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) close();
		};
		// Captured first, so Escape closes the menu and nothing else (the measure or draw tool).
		const onKey = (e: KeyboardEvent) => {
			const menu = ref.current;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				close();
			} else if (
				menu &&
				(e.key === "ArrowDown" || e.key === "ArrowUp") &&
				!(e.target as Element | null)?.closest?.("input, .dye-picker")
			) {
				e.preventDefault();
				e.stopPropagation();
				moveFocus(menu, e.key === "ArrowDown" ? 1 : -1);
			}
		};
		const onBlur = () => close();
		document.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", onBlur);
		return () => {
			document.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("blur", onBlur);
		};
	}, [target]);

	// Next to the clicked spot, flipped to the other side where it would run off the map.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !target || !mv) return;
		const at = mv.blockToScreen(target.anchor.x, target.anchor.z);
		const { width, height } = mv.getSize();
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		let left = at.x + w + MARGIN > width ? at.x - w : at.x;
		let top = at.y + h + MARGIN > height ? at.y - h : at.y;
		left = Math.max(MARGIN, Math.min(left, width - w - MARGIN));
		top = Math.max(MARGIN, Math.min(top, height - h - MARGIN));
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	});

	if (!target || !mv) return null;
	const { x, z } = target;
	const editing = editor.value !== null;
	const measuring = activeTool.value === "measure";
	const layers = layersData.value.filter((l) => l.canEdit);
	const busyTitle = editing
		? "Save or cancel the feature you are editing first"
		: undefined;

	return (
		<div
			ref={ref}
			class="context-menu"
			role="menu"
			aria-label={`Block ${x}, ${z}`}
			onContextMenu={(e) => e.preventDefault()}
		>
			<div class="menu-head">
				{page === "main" ? (
					<span class="menu-coords">
						{x}, {z}
					</span>
				) : (
					<button
						type="button"
						class="plain menu-back"
						onClick={() => setPage(page === "new" ? "layers" : "main")}
					>
						← {page === "new" ? "New layer" : "Add pin to…"}
					</button>
				)}
			</div>

			{page === "main" && (
				<>
					<button
						type="button"
						role="menuitem"
						class="plain menu-item"
						onClick={() => {
							close();
							void copyText(`${x}, ${z}`, `Copied ${x}, ${z}`);
						}}
					>
						Copy coordinates
					</button>
					<button
						type="button"
						role="menuitem"
						class="plain menu-item"
						disabled={editing}
						title={busyTitle}
						onClick={() => {
							close();
							measureFrom({ x, z });
						}}
					>
						Measure from here
					</button>
					{canEditMap.value && (
						<button
							type="button"
							role="menuitem"
							aria-haspopup="menu"
							class="plain menu-item"
							disabled={editing}
							title={busyTitle}
							onClick={() => setPage("layers")}
						>
							Add pin here <span class="menu-more">▶</span>
						</button>
					)}
					{editing && (
						<button
							type="button"
							role="menuitem"
							class="plain menu-item menu-cancel"
							title="Close the feature editor without saving"
							onClick={() => {
								close();
								stopDraw();
								editor.value = null;
							}}
						>
							Cancel editing
						</button>
					)}
					{measuring && (
						<button
							type="button"
							role="menuitem"
							class="plain menu-item menu-cancel"
							onClick={() => {
								close();
								activeTool.value = "none";
							}}
						>
							Cancel measuring
						</button>
					)}
				</>
			)}

			{page === "layers" && (
				<>
					<div class="menu-scroll">
						{layers.map((l) => {
							const full = isLayerFull(l);
							return (
								<button
									key={l.id}
									type="button"
									role="menuitem"
									class="plain menu-item"
									disabled={full}
									title={full ? "This layer is full" : undefined}
									onClick={() => addPin(l.id, x, z)}
								>
									<Banner dye={l.color} />
									<span class="menu-label">{l.name}</span>
								</button>
							);
						})}
						{layers.length === 0 && (
							<p class="muted menu-note">No layers you can add to here.</p>
						)}
					</div>
					<button
						type="button"
						role="menuitem"
						class="plain menu-item menu-new"
						disabled={layerLimitReached.value}
						title={
							layerLimitReached.value
								? "You already have as many layers as one person may create"
								: undefined
						}
						onClick={() => setPage("new")}
					>
						+ New layer…
					</button>
				</>
			)}

			{page === "new" && (
				<NewLayerForm x={x} z={z} onBack={() => setPage("layers")} />
			)}
		</div>
	);
}

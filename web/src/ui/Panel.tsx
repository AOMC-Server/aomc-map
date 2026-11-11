import type { ComponentChildren } from "preact";
import {
	clampPanelWidth,
	panelMaxWidth,
	panelWidth,
	resetPanelWidth,
	setPanelWidth,
} from "../settings";

/** The edge of the panel, dragged (or moved with the arrow keys) to change its width. */
function ResizeHandle() {
	const drag = (e: PointerEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const move = (m: PointerEvent) =>
			// The panel is 8px from the right edge of the window.
			setPanelWidth(innerWidth - 8 - m.clientX, false);
		const done = () => {
			removeEventListener("pointermove", move);
			removeEventListener("pointerup", done);
			removeEventListener("pointercancel", done);
			document.body.classList.remove("resizing");
			setPanelWidth(panelWidth.value);
		};
		addEventListener("pointermove", move);
		addEventListener("pointerup", done);
		addEventListener("pointercancel", done);
		document.body.classList.add("resizing");
	};
	const key = (e: KeyboardEvent) => {
		const step = e.shiftKey ? 80 : 20;
		const next: Record<string, number> = {
			ArrowLeft: panelWidth.value + step,
			ArrowRight: panelWidth.value - step,
			Home: panelMaxWidth(innerWidth),
			End: 0,
		};
		if (!(e.key in next)) return;
		e.preventDefault();
		e.stopPropagation();
		setPanelWidth(next[e.key] as number);
	};
	const width = clampPanelWidth(panelWidth.value, innerWidth);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable splitter, which <hr> cannot be
		<div
			class="panel-resize"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize panel"
			aria-valuemin={clampPanelWidth(0, innerWidth)}
			aria-valuemax={panelMaxWidth(innerWidth)}
			aria-valuenow={width}
			tabIndex={0}
			title="Drag to resize (double-click to reset)"
			onPointerDown={drag}
			onDblClick={resetPanelWidth}
			onKeyDown={key}
		/>
	);
}

/** Side panel with a title bar and a close button; the editor adds a footer. */
export function Panel(props: {
	title: string;
	onClose: () => void;
	closeText?: string;
	class?: string;
	/** Rendered between the title bar and the body (tab strips). */
	tabs?: ComponentChildren;
	footer?: ComponentChildren;
	children: ComponentChildren;
}) {
	return (
		<aside class={`panel ${props.class ?? ""}`} aria-label={props.title}>
			<ResizeHandle />
			<header class="panel-head">
				<h2>{props.title}</h2>
				<button
					type="button"
					class={`btn small ${props.closeText ? "" : "close"}`}
					aria-label="Close"
					onClick={props.onClose}
				>
					{props.closeText ?? "×"}
				</button>
			</header>
			{props.tabs}
			<div class="panel-body">{props.children}</div>
			{props.footer && <footer class="panel-foot">{props.footer}</footer>}
		</aside>
	);
}

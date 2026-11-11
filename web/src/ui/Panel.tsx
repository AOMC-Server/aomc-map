import type { ComponentChildren } from "preact";

/** Side panel drawn as an inventory window, with a title and a close button; the editor adds a footer. */
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
		<aside class={`panel gui ${props.class ?? ""}`} aria-label={props.title}>
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

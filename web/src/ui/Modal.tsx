import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

/** Centered dialog with a title bar, over a dimmed backdrop. Escape closes it before anything else sees the key. */
export function Modal(props: {
	title: string;
	onClose: () => void;
	children: ComponentChildren;
}) {
	const { onClose } = props;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopImmediatePropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	return (
		<div class="modal-backdrop">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label={props.title}
			>
				<header class="modal-head">
					<h2>{props.title}</h2>
					<button
						type="button"
						class="btn small close"
						aria-label="Close"
						onClick={onClose}
					>
						×
					</button>
				</header>
				<div class="modal-body">{props.children}</div>
			</div>
		</div>
	);
}

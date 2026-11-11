import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

/** Centered dialog over a backdrop. Escape closes it before anything else sees the key. */
export function Modal(props: {
	label: string;
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
				aria-label={props.label}
			>
				<button
					type="button"
					class="plain popup-close"
					aria-label="Close"
					onClick={onClose}
				>
					×
				</button>
				{props.children}
			</div>
		</div>
	);
}

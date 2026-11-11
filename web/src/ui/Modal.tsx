import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/** Open modals, oldest first; only the last one reacts to the keyboard. */
const stack: symbol[] = [];

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusablesIn = (root: HTMLElement) =>
	[...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(el) => !el.hidden && el.getClientRects().length > 0,
	);

/**
 * Centered dialog with a title bar, over a dimmed backdrop. Focus moves into it, stays inside
 * while Tab is used, and goes back where it was on close. Escape closes the topmost one only,
 * before anything else sees the key.
 */
export function Modal(props: {
	title: string;
	onClose: () => void;
	children: ComponentChildren;
}) {
	const dialog = useRef<HTMLDivElement>(null);
	const onClose = useRef(props.onClose);
	onClose.current = props.onClose;

	useEffect(() => {
		const id = Symbol("modal");
		stack.push(id);
		const opener = document.activeElement as HTMLElement | null;
		const root = dialog.current;
		if (root) {
			const body = root.querySelector<HTMLElement>(".modal-body");
			(
				(body && focusablesIn(body)[0]) ||
				focusablesIn(root)[0] ||
				root
			).focus();
		}

		const onKey = (e: KeyboardEvent) => {
			if (stack.at(-1) !== id) return;
			if (e.key === "Escape") {
				e.stopImmediatePropagation();
				onClose.current();
				return;
			}
			if (e.key !== "Tab" || !root) return;
			const items = focusablesIn(root);
			const first = items[0];
			const last = items.at(-1);
			if (!first || !last) {
				e.preventDefault();
				root.focus();
			} else if (!root.contains(document.activeElement)) {
				e.preventDefault();
				first.focus();
			} else if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			stack.splice(stack.indexOf(id), 1);
			if (opener?.isConnected) opener.focus();
		};
	}, []);

	return (
		<div class="modal-backdrop">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label={props.title}
				tabIndex={-1}
				ref={dialog}
			>
				<header class="modal-head">
					<h2>{props.title}</h2>
					<button
						type="button"
						class="btn small close"
						aria-label="Close"
						onClick={props.onClose}
					>
						×
					</button>
				</header>
				<div class="modal-body">{props.children}</div>
			</div>
		</div>
	);
}

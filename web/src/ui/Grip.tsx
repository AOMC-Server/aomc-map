import { type CrossDrop, startReorder } from "../reorder";

/**
 * The handle of a list row that can be reordered: drag it, or focus it and press the up and down
 * arrow keys. `id` identifies the row so that focus can go back to it after the list re-renders.
 */
export function Grip(props: {
	id: string;
	label: string;
	index: number;
	count: number;
	onMove: (from: number, to: number) => void;
	/** Lets the row also be dropped on other lists. */
	cross?: CrossDrop;
}) {
	const { id, index, count, onMove } = props;
	return (
		<button
			type="button"
			class="plain grip"
			data-grip={id}
			aria-label={`Move ${props.label}`}
			title={
				props.cross
					? "Drag to reorder or to move to another layer, or press the up and down arrow keys"
					: "Drag to reorder, or press the up and down arrow keys"
			}
			onPointerDown={(e) => {
				const item = e.currentTarget.closest("li");
				if (e.button === 0 && item)
					startReorder(e, e.currentTarget, item, onMove, props.cross);
			}}
			onKeyDown={(e) => {
				const to =
					e.key === "ArrowUp"
						? index - 1
						: e.key === "ArrowDown"
							? index + 1
							: -1;
				if (to < 0 || to >= count) return;
				e.preventDefault();
				e.stopPropagation();
				onMove(index, to);
				// The row is re-created in its new place; keep the keyboard on it.
				setTimeout(
					() =>
						document.querySelector<HTMLElement>(`[data-grip="${id}"]`)?.focus(),
					0,
				);
			}}
		>
			<span class="grip-dots" aria-hidden="true" />
		</button>
	);
}

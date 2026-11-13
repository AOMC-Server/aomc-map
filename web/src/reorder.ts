/** A copy of `items` with the one at `from` moved to index `to`. */
export function moveItem<T>(
	items: readonly T[],
	from: number,
	to: number,
): T[] {
	const out = [...items];
	if (from < 0 || from >= out.length) return out;
	const [moved] = out.splice(from, 1);
	out.splice(Math.min(Math.max(to, 0), out.length), 0, moved as T);
	return out;
}

/**
 * The sort orders that put `items` in the order they have after moving one: every item gets its
 * new position (0..n-1), and only the ones whose order changes are returned.
 */
export function renumber<T extends { sortOrder: number }>(
	items: readonly T[],
	from: number,
	to: number,
): { item: T; sortOrder: number }[] {
	return moveItem(items, from, to).flatMap((item, i) =>
		item.sortOrder === i ? [] : [{ item, sortOrder: i }],
	);
}

/**
 * Where the dragged item ends up: the number of other items whose middle is above `y`, the middle
 * of the dragged item. `mids` are the middles of all items before the drag started.
 */
export function dropIndex(
	mids: readonly number[],
	from: number,
	y: number,
): number {
	let to = 0;
	mids.forEach((m, i) => {
		if (i !== from && m < y) to++;
	});
	return to;
}

/** Where a dragged item lands in another list: the number of its items whose middle is above `y`. */
export const insertIndex = (mids: readonly number[], y: number): number =>
	mids.filter((m) => m < y).length;

/** Dragging an item out of its list onto another one; the targets are elements with `data-drop-layer`. */
export type CrossDrop = {
	/** Whether the item may go to the list with this id. */
	accepts: (id: number) => boolean;
	/** The item was dropped on another list: at `index` among its items, or at the end when null. */
	onDrop: (id: number, index: number | null) => void;
};

const EDGE = 48;
const MAX_SCROLL_SPEED = 14;

function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const overflow = getComputedStyle(p).overflowY;
		if (/(auto|scroll)/.test(overflow) && p.scrollHeight > p.clientHeight)
			return p;
	}
	return null;
}

/**
 * Drags one list item up and down by its handle (pointer events, so it works with touch too).
 * The other items slide out of the way; on release `onDrop(from, to)` is called with the item's
 * old and new index. Escape cancels. The list scrolls when the pointer nears its edge.
 */
export function startReorder(
	e: PointerEvent,
	handle: HTMLElement,
	item: HTMLElement,
	onDrop: (from: number, to: number) => void,
	cross?: CrossDrop,
) {
	const list = item.parentElement;
	if (!list) return;
	const items = [...list.children].filter(
		(c): c is HTMLElement => c instanceof HTMLElement,
	);
	const from = items.indexOf(item);
	if (from < 0 || (items.length < 2 && !cross)) return;

	e.preventDefault();
	handle.setPointerCapture(e.pointerId);
	const scroller = scrollParent(item);
	let startY = e.clientY;
	let startScroll = scroller?.scrollTop ?? 0;
	let mids: number[] = [];
	let slide = 0;
	let pointerX = e.clientX;
	let pointerY = startY;
	let to = from;
	let over: HTMLElement | null = null;
	let frame = 0;
	let moved = false;

	/** Once the pointer has moved: fold the item up, so it is short and the same size as a closed one, then measure. */
	const begin = () => {
		const before = item.getBoundingClientRect().top;
		item.classList.add("dragging");
		const after = item.getBoundingClientRect().top;
		// A shorter list can scroll the item along; keep the pointer on the same spot of it.
		startY += after - before;
		startScroll = scroller?.scrollTop ?? 0;
		const rects = items.map((el) => el.getBoundingClientRect());
		mids = rects.map((r) => r.top + r.height / 2);
		const first = rects[0];
		const second = rects[1];
		const gap = first && second ? Math.max(second.top - first.bottom, 0) : 0;
		slide = (rects[from]?.height ?? 0) + gap;
	};

	const apply = () => {
		if (!moved) {
			if (Math.abs(pointerY - startY) < 4) return;
			moved = true;
			begin();
		}
		const dy = pointerY - startY + ((scroller?.scrollTop ?? 0) - startScroll);
		item.style.transform = `translateY(${dy}px)`;
		const zone = cross ? dropZone() : null;
		if (zone !== over) {
			over?.classList.remove("drop-target");
			zone?.classList.add("drop-target");
			over = zone;
		}
		// Over another list the items of this one stay where they are.
		to = zone ? from : dropIndex(mids, from, (mids[from] ?? 0) + dy);
		items.forEach((el, i) => {
			if (i === from) return;
			const shift =
				from < to && i > from && i <= to
					? -slide
					: from > to && i >= to && i < from
						? slide
						: 0;
			el.style.transform = shift ? `translateY(${shift}px)` : "";
			el.classList.add("sliding");
		});
	};

	/** The list under the pointer that takes the item, if it is not the one it came from. */
	const dropZone = (): HTMLElement | null => {
		for (const el of document.elementsFromPoint(pointerX, pointerY)) {
			const zone = el.closest<HTMLElement>("[data-drop-layer]");
			if (!zone || zone.contains(item)) continue;
			return cross?.accepts(Number(zone.dataset.dropLayer)) ? zone : null;
		}
		return null;
	};

	const tick = () => {
		if (scroller) {
			const r = scroller.getBoundingClientRect();
			const near =
				pointerY < r.top + EDGE
					? -(r.top + EDGE - pointerY)
					: pointerY > r.bottom - EDGE
						? pointerY - (r.bottom - EDGE)
						: 0;
			if (near) {
				scroller.scrollTop +=
					Math.sign(near) * Math.min(Math.abs(near) / 4, MAX_SCROLL_SPEED);
				apply();
			}
		}
		frame = requestAnimationFrame(tick);
	};
	frame = requestAnimationFrame(tick);

	const cleanup = () => {
		cancelAnimationFrame(frame);
		handle.removeEventListener("pointermove", onMove);
		handle.removeEventListener("pointerup", onUp);
		handle.removeEventListener("pointercancel", onCancel);
		window.removeEventListener("keydown", onKey, true);
		over?.classList.remove("drop-target");
		for (const el of items) {
			el.style.transform = "";
			el.classList.remove("dragging", "sliding");
		}
	};
	const onMove = (ev: PointerEvent) => {
		pointerX = ev.clientX;
		pointerY = ev.clientY;
		apply();
	};
	const onUp = () => {
		const zone = over;
		const y = pointerY;
		cleanup();
		if (!moved) return;
		if (zone && cross) {
			const rows = [
				...zone.querySelectorAll<HTMLElement>(".features > li:not(.muted)"),
			];
			const mids = rows.map((r) => {
				const b = r.getBoundingClientRect();
				return b.top + b.height / 2;
			});
			cross.onDrop(
				Number(zone.dataset.dropLayer),
				rows.length > 0 ? insertIndex(mids, y) : null,
			);
		} else if (to !== from) onDrop(from, to);
	};
	const onCancel = () => cleanup();
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key !== "Escape") return;
		ev.stopPropagation();
		cleanup();
	};
	handle.addEventListener("pointermove", onMove);
	handle.addEventListener("pointerup", onUp);
	handle.addEventListener("pointercancel", onCancel);
	window.addEventListener("keydown", onKey, true);
}

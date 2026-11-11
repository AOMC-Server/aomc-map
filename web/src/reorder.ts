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
) {
	const list = item.parentElement;
	if (!list) return;
	const items = [...list.children].filter(
		(c): c is HTMLElement => c instanceof HTMLElement,
	);
	const from = items.indexOf(item);
	if (from < 0 || items.length < 2) return;

	e.preventDefault();
	handle.setPointerCapture(e.pointerId);
	const scroller = scrollParent(item);
	const startScroll = scroller?.scrollTop ?? 0;
	const startY = e.clientY;
	const rects = items.map((el) => el.getBoundingClientRect());
	const mids = rects.map((r) => r.top + r.height / 2);
	const second = rects[1];
	const first = rects[0];
	const gap = second && first ? Math.max(second.top - first.bottom, 0) : 0;
	const slide = (rects[from]?.height ?? 0) + gap;

	let pointerY = startY;
	let to = from;
	let frame = 0;
	let moved = false;

	const apply = () => {
		const dy = pointerY - startY + ((scroller?.scrollTop ?? 0) - startScroll);
		if (!moved && Math.abs(dy) < 4) return;
		moved = true;
		item.classList.add("dragging");
		item.style.transform = `translateY(${dy}px)`;
		to = dropIndex(mids, from, (mids[from] ?? 0) + dy);
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
		for (const el of items) {
			el.style.transform = "";
			el.classList.remove("dragging", "sliding");
		}
	};
	const onMove = (ev: PointerEvent) => {
		pointerY = ev.clientY;
		apply();
	};
	const onUp = () => {
		cleanup();
		if (moved && to !== from) onDrop(from, to);
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

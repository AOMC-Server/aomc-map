/**
 * New `sortOrder` values for putting `ids` in the given order.
 *
 * The values the items already have are reused, handed out in ascending order, so that items
 * that are not part of the list (e.g. private layers the user cannot see) keep their place
 * between the others. Equal values are pulled apart so the order always takes effect.
 */
export function assignOrder(
	current: { id: number; sortOrder: number }[],
	ids: number[],
): { id: number; sortOrder: number }[] {
	const slots = current.map((c) => c.sortOrder).sort((a, b) => a - b);
	for (let i = 1; i < slots.length; i++) {
		const prev = slots[i - 1] as number;
		if ((slots[i] as number) <= prev) slots[i] = prev + 1;
	}
	return ids.map((id, i) => ({ id, sortOrder: slots[i] as number }));
}

/** True when `ids` has no repeats and holds exactly the ids of `current`. */
export function sameSet(current: { id: number }[], ids: number[]): boolean {
	if (new Set(ids).size !== ids.length || ids.length !== current.length)
		return false;
	const wanted = new Set(current.map((c) => c.id));
	return ids.every((id) => wanted.has(id));
}

type Ordered = { id: number; sortOrder: number };

/**
 * New `sortOrder` values for putting `ids` in the given order.
 *
 * The values the items already have are reused, handed out in ascending order, so that items
 * that are not part of the list (e.g. private layers the user cannot see) keep their place
 * between the others. Equal values are pulled apart so the order always takes effect.
 *
 * `others` are the rows of the same scope that are not in the list. If pulling values apart
 * lands on one of theirs, every row is renumbered 0..n-1 instead (and `others` are included in
 * the result), keeping their places between the listed rows.
 */
export function assignOrder(
	current: Ordered[],
	ids: number[],
	others: Ordered[] = [],
): Ordered[] {
	const slots = current.map((c) => c.sortOrder).sort((a, b) => a - b);
	for (let i = 1; i < slots.length; i++) {
		const prev = slots[i - 1] as number;
		if ((slots[i] as number) <= prev) slots[i] = prev + 1;
	}
	const updates = ids.map((id, i) => ({ id, sortOrder: slots[i] as number }));

	const taken = new Set(others.map((o) => o.sortOrder));
	if (!updates.some((u) => taken.has(u.sortOrder))) return updates;

	const listed = new Set(current.map((c) => c.id));
	const rest = [...ids];
	return [...current, ...others]
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
		.map((row, i) => ({
			id: listed.has(row.id) ? (rest.shift() as number) : row.id,
			sortOrder: i,
		}));
}

/** True when `ids` has no repeats and holds exactly the ids of `current`. */
export function sameSet(current: { id: number }[], ids: number[]): boolean {
	if (new Set(ids).size !== ids.length || ids.length !== current.length)
		return false;
	const wanted = new Set(current.map((c) => c.id));
	return ids.every((id) => wanted.has(id));
}

/** The `sortOrder` that puts a new item after all of `rows`. */
export const nextSortOrder = (rows: { sortOrder: number }[]) =>
	rows.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1;

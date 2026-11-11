import type { RevisionInfo } from "./state";

export const inFlight = (r: RevisionInfo) =>
	r.status === "pending" || r.status === "processing";

/** Whether the newest page misses revisions between what is loaded and itself. */
export function pageHasGap(
	known: readonly { id: number }[],
	nextBefore: number | null,
): boolean {
	return nextBefore !== null && !known.some((r) => r.id >= nextBefore);
}

/**
 * Merges the newest page (and the revisions still being processed) into what is loaded. The
 * page holds every revision from `nextBefore` up; one missing from it was deleted.
 */
export function mergeRevisions(
	known: readonly RevisionInfo[],
	revisions: readonly RevisionInfo[],
	nextBefore: number | null,
	active: readonly number[],
): RevisionInfo[] {
	const fresh = new Map(revisions.map((r) => [r.id, r]));
	const covered = (id: number) =>
		nextBefore === null || id > nextBefore || active.includes(id);
	const kept = known
		.filter((r) => fresh.has(r.id) || !covered(r.id))
		.map((r) => fresh.get(r.id) ?? r);
	const have = new Set(kept.map((r) => r.id));
	return [...kept, ...revisions.filter((r) => !have.has(r.id))].sort(
		(a, b) => b.id - a.id,
	);
}

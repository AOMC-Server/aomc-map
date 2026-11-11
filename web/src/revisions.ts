import { signal } from "@preact/signals";
import { api, attempt, run, showNotice } from "./api";
import { refreshMap, setRev } from "./controller";
import { loadLayers } from "./layers";
import { pollUntil } from "./poll";
import { inFlight, mergeRevisions, pageHasGap } from "./revisionLog";
import {
	dimSlug,
	isolatedUpload,
	type RevisionInfo,
	revisionsData,
} from "./state";

export type Progress = { message?: string; done?: number; total?: number };
export type Outcome = { status: "done" | "failed"; error: string | null };

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 5;
/** How long to follow a job before giving up on it (it may well still finish). */
const FOLLOW_TIMEOUT_MS = 30 * 60_000;

type Lookup =
	| { kind: "found"; revision: RevisionInfo }
	| { kind: "gone" }
	| { kind: "error" };

/** Quiet lookup (no error toast), telling a deleted revision apart from a failed request. */
async function lookupRevision(id: number): Promise<Lookup> {
	try {
		const res = await api.api.revisions[":id"].$get({
			param: { id: String(id) },
		});
		if (res.status === 404) return { kind: "gone" };
		return res.ok
			? { kind: "found", revision: (await res.json()).revision }
			: { kind: "error" };
	} catch {
		return { kind: "error" };
	}
}

/** The revision, or null if it is gone or could not be fetched; used while polling a job. */
export async function fetchRevision(id: number): Promise<RevisionInfo | null> {
	const found = await lookupRevision(id);
	return found.kind === "found" ? found.revision : null;
}

/** The dimension `revisionsData` holds the whole history of. */
let loadedDim: string | null = null;

/**
 * Loads the upload log of the dimension being viewed (newest first): all of it the first time
 * or with `full`, afterwards only what is new or still changing.
 */
export async function loadRevisions(full = false): Promise<void> {
	const dim = dimSlug.value;
	if (!dim) {
		loadedDim = null;
		revisionsData.value = [];
		return;
	}
	if (full || loadedDim !== dim) await loadAll(dim);
	else await refresh(dim);
}

async function loadAll(dim: string) {
	const all: RevisionInfo[] = [];
	let before: number | null = null;
	for (;;) {
		const query: Record<string, string> = { dimension: dim, limit: "1000" };
		if (before !== null) query.before = String(before);
		const out = await run(() => api.api.revisions.$get({ query }));
		if (!out || dimSlug.value !== dim) return;
		all.push(...out.revisions);
		if (out.nextBefore === null) break;
		before = out.nextBefore;
	}
	loadedDim = dim;
	setRevisions(all);
}

/** Replaces the loaded history of the dimension, dropping an isolated upload that is gone from it. */
function setRevisions(list: RevisionInfo[]) {
	revisionsData.value = list;
	const shown = isolatedUpload.value;
	if (shown && !list.some((r) => r.id === shown.id))
		isolatedUpload.value = null;
}

async function refresh(dim: string) {
	const active = revisionsData.value
		.filter((r) => inFlight(r) || r.deleting)
		.map((r) => r.id);
	const query: Record<string, string> = { dimension: dim, limit: "100" };
	if (active.length) query.active = active.join(",");
	const res = await attempt(() => api.api.revisions.$get({ query }));
	if (!res.ok || dimSlug.value !== dim || loadedDim !== dim) return;
	const { revisions, nextBefore } = res.body;
	// More than a page of new uploads since the last look: the ones in between are unknown.
	if (pageHasGap(revisionsData.value, nextBefore)) return loadAll(dim);
	const merged = mergeRevisions(
		revisionsData.value,
		revisions,
		nextBefore,
		active,
	);
	if (JSON.stringify(merged) !== JSON.stringify(revisionsData.value))
		setRevisions(merged);
}

/**
 * Follows a revision until it finishes, using server-sent events and falling back to polling if
 * the stream breaks. Resolves once with the outcome; gives up after repeated failures, after
 * `FOLLOW_TIMEOUT_MS`, or when `signal` aborts (the job itself keeps running).
 */
export function watchRevision(
	revisionId: number,
	onProgress?: (p: Progress) => void,
	signal?: AbortSignal,
): Promise<Outcome> {
	return new Promise((resolve) => {
		let settled = false;
		let source: EventSource | undefined;
		const stop = new AbortController();
		const settle = (outcome: Outcome) => {
			if (settled) return;
			settled = true;
			source?.close();
			stop.abort();
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = () => settle({ status: "failed", error: "Cancelled." });
		const timer = setTimeout(
			() =>
				settle({
					status: "failed",
					error: "Still processing; check the history panel later.",
				}),
			FOLLOW_TIMEOUT_MS,
		);
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort);

		const poll = async () => {
			let failures = 0;
			const out = await pollUntil<Outcome>(
				async () => {
					const r = await fetchRevision(revisionId);
					if (r?.status === "done") return { status: "done", error: null };
					if (r?.status === "failed")
						return { status: "failed", error: r.error };
					failures = r ? 0 : failures + 1;
					if (failures >= MAX_POLL_FAILURES)
						return { status: "failed", error: "Lost contact with the server." };
				},
				{
					intervalMs: POLL_MS,
					timeoutMs: FOLLOW_TIMEOUT_MS,
					signal: stop.signal,
				},
			);
			if (out.done) settle(out.value);
		};

		source = new EventSource(`/api/revisions/${revisionId}/events`);
		const progress = (e: MessageEvent) => {
			if (!settled) onProgress?.(JSON.parse(e.data) as Progress);
		};
		source.addEventListener("pending", progress);
		source.addEventListener("processing", progress);
		source.addEventListener("done", () => {
			settle({ status: "done", error: null });
		});
		source.addEventListener("failed", (e) => {
			settle({
				status: "failed",
				error:
					(JSON.parse((e as MessageEvent).data) as { error?: string }).error ??
					null,
			});
		});
		source.onerror = () => {
			if (settled) return;
			source?.close();
			void poll();
		};
	});
}

/** Uploads this browser has asked to delete and are still being erased, with what they are doing. */
export const deleting = signal<Map<number, string>>(new Map());

const setDeleting = (id: number, label: string | null) => {
	const next = new Map(deleting.value);
	if (label === null) next.delete(id);
	else next.set(id, label);
	deleting.value = next;
};

/**
 * Deletes an upload from the map and all of its history (moderators, or its author for a while
 * after uploading it). The server erases it in the background; this waits until it is gone (or
 * the erase failed) and refreshes the map.
 */
export async function deleteUpload(id: number): Promise<boolean> {
	if (deleting.value.has(id)) return false;
	// Marked busy before the request, so the row cannot be deleted twice meanwhile.
	setDeleting(id, "deleting…");
	const out = await run(() =>
		api.api.revisions[":id"].$delete({ param: { id: String(id) } }),
	);
	if (!out) {
		setDeleting(id, null);
		return false;
	}
	// Shows it as busy right away, wherever it is in the log.
	const busy = await fetchRevision(id);
	if (busy)
		revisionsData.value = revisionsData.value.map((r) =>
			r.id === id ? busy : r,
		);

	// Progress only; whether it is finished is decided by the polling below.
	const events = new EventSource(`/api/revisions/${id}/events`);
	events.addEventListener("processing", (e) => {
		const p = JSON.parse((e as MessageEvent).data) as Progress;
		setDeleting(
			id,
			p.total ? `deleting ${p.done ?? 0}/${p.total}` : `deleting: ${p.message}`,
		);
	});
	events.onerror = () => events.close();

	let failures = 0;
	const result = await pollUntil<{ error: string | null }>(
		async () => {
			const found = await lookupRevision(id);
			if (found.kind === "gone") return { error: null };
			if (found.kind === "error") {
				if (++failures >= MAX_POLL_FAILURES)
					return { error: "Lost contact with the server." };
				return undefined;
			}
			failures = 0;
			const r = found.revision;
			if (r.status === "done" && r.error) return { error: r.error };
		},
		{ intervalMs: POLL_MS, timeoutMs: FOLLOW_TIMEOUT_MS },
	);
	const error = result.done
		? result.value.error
		: "Still deleting; check the history panel later.";

	events.close();
	setDeleting(id, null);
	if (isolatedUpload.value?.id === id) isolatedUpload.value = null;
	showNotice(error ?? "Upload deleted.", error ? "error" : "info");
	await refreshMap();
	await loadRevisions(true);
	return error === null;
}

/** One page of a feature's history, newest first; `before` continues after a page's `nextBefore`. */
export async function loadFeatureHistory(featureId: number, before?: number) {
	const out = await run(() =>
		api.api.features[":id"].history.$get({
			param: { id: String(featureId) },
			query: before === undefined ? {} : { before: String(before) },
		}),
	);
	return out ?? null;
}

export type FeatureHistoryEntry = NonNullable<
	Awaited<ReturnType<typeof loadFeatureHistory>>
>["history"][number];

/** Makes an old version of a feature current again (moderators), then shows the present. */
export async function restoreFeatureRevision(
	featureId: number,
	revisionId: number,
): Promise<boolean> {
	const out = await run(() =>
		api.api.features[":id"].restore[":revisionId"].$post({
			param: { id: String(featureId), revisionId: String(revisionId) },
		}),
	);
	if (!out) return false;
	setRev(null);
	await loadLayers();
	showNotice("Feature restored.");
	return true;
}

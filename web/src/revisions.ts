import { signal } from "@preact/signals";
import { api, attempt, run, showNotice } from "./api";
import { refreshMap, setRev } from "./controller";
import { subscribe } from "./events";
import { loadLayers } from "./layers";
import { inFlight, mergeRevisions, pageHasGap } from "./revisionLog";
import {
	dimSlug,
	isolatedUpload,
	mapEpoch,
	type RevisionInfo,
	revisionsData,
} from "./state";
import { formatProgress } from "./ui/format";

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
/** The map's epoch when it was loaded: a new one means history was rewritten (revision numbers may have changed). */
let loadedEpoch: number | null = null;

/**
 * Loads the upload log of the dimension being viewed (newest first): all of it the first time,
 * with `full` or after history was rewritten, otherwise only what is new or still changing.
 */
export async function loadRevisions(full = false): Promise<void> {
	const dim = dimSlug.value;
	if (!dim) {
		loadedDim = null;
		revisionsData.value = [];
		return;
	}
	if (full || loadedDim !== dim || loadedEpoch !== mapEpoch.value)
		await loadAll(dim);
	else await refresh(dim);
}

async function loadAll(dim: string) {
	const epoch = mapEpoch.value;
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
	loadedEpoch = epoch;
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

type Followed = { status: "done" | "failed" | "gone"; error: string | null };

type FollowOptions = {
	/** Following a delete: the revision going away is what success looks like. */
	erase?: boolean;
	onProgress?: (p: Progress) => void;
	signal?: AbortSignal;
	/** What to report when `FOLLOW_TIMEOUT_MS` passes first. */
	timeoutError: string;
};

/**
 * Follows a revision's job on the shared event stream (polling it while the stream is down)
 * until it ends: done, failed or gone (erased). Resolves once; gives up after repeated failures
 * to reach the server, after `FOLLOW_TIMEOUT_MS`, or when `signal` aborts (the job itself keeps
 * running). Giving up is reported as a failure.
 */
function followRevision(
	revisionId: number,
	opts: FollowOptions,
): Promise<Followed> {
	return new Promise((resolve) => {
		const { erase, onProgress, signal } = opts;
		let settled = false;
		let failures = 0;
		let looking = false;
		let unsubscribe: (() => void) | undefined;
		let fallback: ReturnType<typeof setInterval> | undefined;
		const settle = (outcome: Followed) => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			clearInterval(fallback);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const fail = (error: string | null): Followed => ({
			status: "failed",
			error,
		});
		const onAbort = () => settle(fail("Cancelled."));
		const timer = setTimeout(
			() => settle(fail(opts.timeoutError)),
			FOLLOW_TIMEOUT_MS,
		);
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort);

		const look = async () => {
			if (looking || settled) return;
			looking = true;
			const found = await lookupRevision(revisionId);
			looking = false;
			if (settled) return;
			if (found.kind === "gone") return settle({ status: "gone", error: null });
			if (found.kind === "error") {
				if (++failures >= MAX_POLL_FAILURES)
					settle(fail("Lost contact with the server."));
				return;
			}
			failures = 0;
			const r = found.revision;
			if (r.status === "failed") settle(fail(r.error));
			else if (r.status === "done") {
				if (!erase) settle({ status: "done", error: null });
				// A delete that failed leaves the upload in place, with the reason.
				else if (r.error) settle(fail(r.error));
			}
		};
		/** For when the stream cannot say how it ended: ask until the revision answers. */
		const lookUntilSettled = () => {
			if (fallback) return;
			void look();
			fallback = setInterval(look, POLL_MS);
		};

		unsubscribe = subscribe(`revision:${revisionId}`, {
			onEvent: (e) => {
				if (settled) return;
				switch (e.status) {
					case "gone":
						return settle({ status: "gone", error: null });
					case "failed":
						return settle(
							fail(
								erase
									? `delete failed: ${e.error ?? "unknown error"}`
									: (e.error ?? null),
							),
						);
					case "done":
						if (!erase) return settle({ status: "done", error: null });
						if (e.error) return settle(fail(e.error));
						// The erase has not touched it yet; the stream has nothing more to say.
						return lookUntilSettled();
					default:
						onProgress?.(e);
				}
			},
			onError: (error) => {
				if (error === "not found") settle({ status: "gone", error: null });
				else lookUntilSettled();
			},
			poll: look,
			pollMs: POLL_MS,
		});
		if (settled) unsubscribe();
	});
}

/**
 * Follows an upload until it finishes. Resolves once with the outcome; gives up after repeated
 * failures to reach the server, after `FOLLOW_TIMEOUT_MS`, or when `signal` aborts (the job
 * itself keeps running).
 */
export async function watchRevision(
	revisionId: number,
	onProgress?: (p: Progress) => void,
	signal?: AbortSignal,
): Promise<Outcome> {
	const out = await followRevision(revisionId, {
		onProgress,
		signal,
		timeoutError: "Still processing; check the history panel later.",
	});
	return out.status === "gone"
		? { status: "failed", error: "The upload was deleted." }
		: { status: out.status, error: out.error };
}

/**
 * Uploads this browser has asked to delete and are still being erased: a short `label` for a
 * badge, and `detail` saying what the server is doing.
 */
export const deleting = signal<Map<number, { label: string; detail: string }>>(
	new Map(),
);

const setDeleting = (
	id: number,
	state: { label: string; detail: string } | null,
) => {
	const next = new Map(deleting.value);
	if (state === null) next.delete(id);
	else next.set(id, state);
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
	setDeleting(id, {
		label: "deleting…",
		detail: "Waiting for the server to start deleting it",
	});
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

	const result = await followRevision(id, {
		erase: true,
		timeoutError: "Still deleting; check the history panel later.",
		onProgress: (p) =>
			setDeleting(id, {
				label: p.total
					? `deleting ${Math.round(((p.done ?? 0) / p.total) * 100)}%`
					: "deleting…",
				detail: formatProgress(p.message ?? "Deleting", p.done, p.total),
			}),
	});
	const error =
		result.status === "gone" ? null : (result.error ?? "unknown error");

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

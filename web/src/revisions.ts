import { signal } from "@preact/signals";
import { api, run, showNotice } from "./api";
import { refreshMap, setRev } from "./controller";
import { loadLayers } from "./layers";
import { isolatedUpload, type RevisionInfo, revisionsData } from "./state";

export type Progress = { message?: string; done?: number; total?: number };
export type Outcome = { status: "done" | "failed"; error: string | null };

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 5;

/** Quiet lookup (no error toast): used while polling a job. */
export async function fetchRevision(id: number): Promise<RevisionInfo | null> {
	try {
		const res = await api.api.revisions[":id"].$get({
			param: { id: String(id) },
		});
		return res.ok ? (await res.json()).revision : null;
	} catch {
		return null;
	}
}

/** Loads the revision log (newest first). */
export async function loadRevisions(): Promise<void> {
	const out = await run(() => api.api.revisions.$get({ query: {} }));
	if (out) revisionsData.value = out.revisions;
}

/**
 * Follows a revision until it finishes, using server-sent events and falling back to polling if
 * the stream breaks. Resolves once with the outcome; polling gives up after repeated failures.
 */
export function watchRevision(
	revisionId: number,
	onProgress?: (p: Progress) => void,
): Promise<Outcome> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (outcome: Outcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};

		const poll = async () => {
			let failures = 0;
			while (!settled) {
				const r = await fetchRevision(revisionId);
				if (r?.status === "done")
					return settle({ status: "done", error: null });
				if (r?.status === "failed")
					return settle({ status: "failed", error: r.error });
				failures = r ? 0 : failures + 1;
				if (failures >= MAX_POLL_FAILURES)
					return settle({
						status: "failed",
						error: "Lost contact with the server.",
					});
				await new Promise((r) => setTimeout(r, POLL_MS));
			}
		};

		const source = new EventSource(`/api/revisions/${revisionId}/events`);
		const progress = (e: MessageEvent) => {
			if (!settled) onProgress?.(JSON.parse(e.data) as Progress);
		};
		source.addEventListener("pending", progress);
		source.addEventListener("processing", progress);
		source.addEventListener("done", () => {
			source.close();
			settle({ status: "done", error: null });
		});
		source.addEventListener("failed", (e) => {
			source.close();
			settle({
				status: "failed",
				error:
					(JSON.parse((e as MessageEvent).data) as { error?: string }).error ??
					null,
			});
		});
		source.onerror = () => {
			if (settled) return;
			source.close();
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deletes an upload from the map and all of its history (moderators). The server erases it in
 * the background; this waits until it is gone (or the erase failed) and refreshes the map.
 */
export async function deleteUpload(id: number): Promise<boolean> {
	const out = await run(() =>
		api.api.revisions[":id"].$delete({ param: { id: String(id) } }),
	);
	if (!out) return false;
	setDeleting(id, "deleting…");
	await loadRevisions(); // shows it as busy right away

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

	let error: string | null = null;
	let failures = 0;
	for (;;) {
		const r = await fetchRevision(id);
		if (r === null) {
			// Gone; but a lost connection looks the same, so ask the log before believing it.
			const gone = await run(() => api.api.revisions.$get({ query: {} }));
			if (gone && !gone.revisions.some((x) => x.id === id)) break;
			if (++failures >= MAX_POLL_FAILURES) {
				error = "Lost contact with the server.";
				break;
			}
		} else if (r.status === "done" && r.error) {
			error = r.error;
			break;
		}
		await sleep(POLL_MS);
	}

	events.close();
	setDeleting(id, null);
	if (isolatedUpload.value?.id === id) isolatedUpload.value = null;
	showNotice(error ?? "Upload deleted.", error ? "error" : "info");
	await refreshMap();
	await loadRevisions();
	return error === null;
}

export async function loadFeatureHistory(featureId: number) {
	const out = await run(() =>
		api.api.features[":id"].history.$get({ param: { id: String(featureId) } }),
	);
	return out?.history ?? null;
}

export type FeatureHistoryEntry = NonNullable<
	Awaited<ReturnType<typeof loadFeatureHistory>>
>[number];

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

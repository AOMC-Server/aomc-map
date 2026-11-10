import { api } from "./api";
import { refreshHead, setRev } from "./controller";
import { loadLayers, showNotice } from "./layers";
import { currentMap, type RevisionInfo, revisionsData } from "./state";

export type Progress = { message?: string; done?: number; total?: number };
export type Outcome = { status: "done" | "failed"; error: string | null };

export async function fetchRevision(id: number): Promise<RevisionInfo | null> {
	try {
		const res = await fetch(`/api/revisions/${id}`);
		return res.ok
			? ((await res.json()) as { revision: RevisionInfo }).revision
			: null;
	} catch {
		return null;
	}
}

/** Loads the revision log of the current map (newest first). */
export async function loadRevisions(): Promise<void> {
	const detail = currentMap.value;
	if (!detail) {
		revisionsData.value = [];
		return;
	}
	const res = await api.api.maps[":slug"].revisions.$get({
		param: { slug: detail.map.slug },
	});
	if (res.ok && currentMap.value === detail) {
		revisionsData.value = (
			(await res.json()) as { revisions: RevisionInfo[] }
		).revisions;
	}
}

/**
 * Follows a revision until it finishes, using server-sent events and falling back to polling if
 * the stream breaks. Resolves once with the outcome.
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
			while (!settled) {
				const r = await fetchRevision(revisionId);
				if (r?.status === "done")
					return settle({ status: "done", error: null });
				if (r?.status === "failed")
					return settle({ status: "failed", error: r.error });
				await new Promise((r) => setTimeout(r, 1500));
			}
		};

		if (typeof EventSource === "undefined") {
			void poll();
			return;
		}
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

/** Reverts or unreverts an upload (moderators), waits for the result and refreshes the map. */
export async function revertUpload(
	targetId: number,
	kind: "revert" | "unrevert",
): Promise<boolean> {
	const res = await fetch(`/api/revisions/${targetId}/${kind}`, {
		method: "POST",
	});
	const body = (await res.json().catch(() => ({}))) as {
		revisionId?: number;
		error?: string;
	};
	if (res.status !== 202 || !body.revisionId) {
		showNotice(body.error ?? `Could not ${kind} (${res.status}).`, "error");
		return false;
	}
	await loadRevisions(); // shows the pending operation right away
	const outcome = await watchRevision(body.revisionId);
	if (outcome.status === "failed") {
		showNotice(
			`The ${kind} failed: ${outcome.error ?? "unknown error"}`,
			"error",
		);
	} else {
		showNotice(kind === "revert" ? "Upload reverted." : "Upload restored.");
	}
	await refreshHead();
	await loadRevisions();
	return outcome.status === "done";
}

export type FeatureHistoryEntry = {
	revisionId: number;
	authorId: string;
	authorName: string;
	createdAt: number;
	deleted: boolean;
	type: "pin" | "line" | "polygon";
	name: string;
	popup: string;
	color: string | null;
	geometry: unknown;
};

export async function loadFeatureHistory(
	featureId: number,
): Promise<FeatureHistoryEntry[] | null> {
	const res = await api.api.features[":id"].history.$get({
		param: { id: String(featureId) },
	});
	if (!res.ok) return null;
	return ((await res.json()) as { history: FeatureHistoryEntry[] }).history;
}

/** Makes an old version of a feature current again (moderators), then shows the present. */
export async function restoreFeatureRevision(
	featureId: number,
	revisionId: number,
): Promise<boolean> {
	const res = await api.api.features[":id"].restore[":revisionId"].$post({
		param: { id: String(featureId), revisionId: String(revisionId) },
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		showNotice(body.error ?? `Could not restore (${res.status}).`, "error");
		return false;
	}
	setRev(null);
	await loadLayers();
	showNotice("Feature restored.");
	return true;
}

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { dyeLabel, pointsOf, TYPE_LABEL } from "../featureInfo";
import {
	type FeatureHistoryEntry,
	loadFeatureHistory,
	restoreFeatureRevision,
} from "../revisions";
import { isModerator, popup, readOnly } from "../state";
import { formatTime } from "./format";
import { Modal } from "./Modal";

/** The feature whose revision list is open. */
export const featureHistoryFor = signal<{
	featureId: number;
	title: string;
} | null>(null);

const close = () => {
	featureHistoryFor.value = null;
};

function summary(e: FeatureHistoryEntry): string {
	const points = pointsOf(e);
	const first = points[0];
	const where =
		e.type === "pin" && first
			? `at ${first[0]}, ${first[1]}`
			: `${new Set(points.map(String)).size} points`;
	const color = e.color ? `, ${dyeLabel(e.color)}` : "";
	return `${TYPE_LABEL[e.type]} "${e.name || "unnamed"}" ${where}${color}`;
}

/** Revision list of one feature. Moderators can make an old version current again. */
export function FeatureHistory() {
	const target = featureHistoryFor.value;
	const [entries, setEntries] = useState<FeatureHistoryEntry[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [nextBefore, setNextBefore] = useState<number | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const featureId = target?.featureId;

	useEffect(() => {
		if (featureId === undefined) return;
		setEntries(null);
		setFailed(false);
		setNextBefore(null);
		void loadFeatureHistory(featureId).then((page) => {
			setEntries(page?.history ?? null);
			setNextBefore(page?.nextBefore ?? null);
			setFailed(page === null);
		});
	}, [featureId]);

	if (!target) return null;

	const loadOlder = async () => {
		if (nextBefore === null || loadingMore) return;
		setLoadingMore(true);
		try {
			const page = await loadFeatureHistory(target.featureId, nextBefore);
			if (!page) return;
			setEntries((prev) => [...(prev ?? []), ...page.history]);
			setNextBefore(page.nextBefore);
		} finally {
			setLoadingMore(false);
		}
	};

	const restore = async (e: FeatureHistoryEntry) => {
		const what = e.deleted ? "deleted state" : "this version";
		if (!confirm(`Restore ${what} from ${formatTime(e.createdAt)}?`)) return;
		setBusy(true);
		let ok = false;
		try {
			ok = await restoreFeatureRevision(target.featureId, e.revisionId);
		} finally {
			setBusy(false);
		}
		if (ok) {
			close();
			popup.value = null;
		}
	};

	return (
		<Modal title={`History of “${target.title}”`} onClose={close}>
			{entries === null && !failed && <p class="muted">Loading…</p>}
			{failed && <p class="error-text">Could not load the history.</p>}
			<ul class="feature-history">
				{entries?.map((e, i) => (
					<li key={e.revisionId} class={e.deleted ? "deleted" : ""}>
						<div class="fh-main">
							<div>
								{e.deleted ? (
									<b>Deleted</b>
								) : i === entries.length - 1 && nextBefore === null ? (
									<b>Created</b>
								) : (
									<b>Edited</b>
								)}
								{i === 0 && <span class="badge">current</span>}
							</div>
							<div class="muted">{summary(e)}</div>
							<div class="muted">
								{e.authorName} · {formatTime(e.createdAt)}
							</div>
						</div>
						{isModerator.value && !readOnly.value && i > 0 && (
							<button
								type="button"
								class="btn small"
								disabled={busy}
								onClick={() => restore(e)}
							>
								Restore
							</button>
						)}
					</li>
				))}
			</ul>
			{nextBefore !== null && (
				<button
					type="button"
					class="btn small"
					disabled={loadingMore}
					onClick={loadOlder}
				>
					{loadingMore ? "Loading…" : "Load older"}
				</button>
			)}
			{!isModerator.value && entries && (
				<p class="muted">Only moderators can restore earlier versions.</p>
			)}
			{isModerator.value && readOnly.value && entries && (
				<p class="muted">
					The map is in maintenance, so earlier versions can't be restored for
					now.
				</p>
			)}
		</Modal>
	);
}

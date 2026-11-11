import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { dyeLabel, pointsOf, TYPE_LABEL } from "../featureInfo";
import {
	type FeatureHistoryEntry,
	loadFeatureHistory,
	restoreFeatureRevision,
} from "../revisions";
import { isModerator, popup } from "../state";
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
			: `${points.length} points`;
	const color = e.color ? `, ${dyeLabel(e.color)}` : "";
	return `${TYPE_LABEL[e.type]} "${e.name || "unnamed"}" ${where}${color}`;
}

/** Revision list of one feature. Moderators can make an old version current again. */
export function FeatureHistory() {
	const target = featureHistoryFor.value;
	const [entries, setEntries] = useState<FeatureHistoryEntry[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const featureId = target?.featureId;

	useEffect(() => {
		if (featureId === undefined) return;
		setEntries(null);
		setFailed(false);
		void loadFeatureHistory(featureId).then((list) => {
			setEntries(list);
			setFailed(list === null);
		});
	}, [featureId]);

	if (!target) return null;

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
								) : i === entries.length - 1 ? (
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
						{isModerator.value && i > 0 && (
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
			{!isModerator.value && entries && (
				<p class="muted">Only moderators can restore earlier versions.</p>
			)}
		</Modal>
	);
}

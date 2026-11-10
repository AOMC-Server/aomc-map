import type { Point } from "@aomc/shared/features";
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import {
	type FeatureHistoryEntry,
	loadFeatureHistory,
	restoreFeatureRevision,
} from "../revisions";
import { isModerator, popup } from "../state";
import { dyeLabel, formatTime } from "./format";

/** The feature whose revision list is open. */
export const featureHistoryFor = signal<{
	featureId: number;
	title: string;
} | null>(null);

const TYPE_LABEL = { pin: "Pin", line: "Line", polygon: "Area" } as const;

function summary(e: FeatureHistoryEntry): string {
	const g = e.geometry;
	const where =
		e.type === "pin"
			? `at ${(g as Point)[0]}, ${(g as Point)[1]}`
			: `${(g as Point[]).length} points`;
	const color = e.color ? `, ${dyeLabel(e.color)}` : "";
	return `${TYPE_LABEL[e.type]} "${e.name || "unnamed"}" ${where}${color}`;
}

/** Revision list of one feature. Moderators can make an old version current again. */
export function FeatureHistory() {
	const target = featureHistoryFor.value;
	const [entries, setEntries] = useState<FeatureHistoryEntry[] | null>(null);
	const [busy, setBusy] = useState(false);
	const featureId = target?.featureId;

	useEffect(() => {
		if (featureId === undefined) return;
		setEntries(null);
		void loadFeatureHistory(featureId).then(setEntries);
	}, [featureId]);

	useEffect(() => {
		if (!target) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") featureHistoryFor.value = null;
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [target]);

	if (!target) return null;

	const restore = async (e: FeatureHistoryEntry) => {
		const what = e.deleted ? "deleted state" : "this version";
		if (!confirm(`Restore ${what} from ${formatTime(e.createdAt)}?`)) return;
		setBusy(true);
		const ok = await restoreFeatureRevision(target.featureId, e.revisionId);
		setBusy(false);
		if (ok) {
			featureHistoryFor.value = null;
			popup.value = null;
		}
	};

	return (
		<div class="modal-backdrop">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Feature history"
			>
				<button
					type="button"
					class="popup-close"
					aria-label="Close"
					onClick={() => (featureHistoryFor.value = null)}
				>
					×
				</button>
				<h2>History of “{target.title}”</h2>
				{entries === null && <p class="muted">Loading…</p>}
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
			</div>
		</div>
	);
}

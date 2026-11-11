import { useEffect, useState } from "preact/hooks";
import { showNotice } from "../api";
import { isolateUpload, mapView, selectDimension, setRev } from "../controller";
import { deleteUpload, deleting, loadRevisions } from "../revisions";
import {
	currentMap,
	dimSlug,
	effectiveRev,
	highlightBbox,
	isModerator,
	isolatedUpload,
	type RevisionInfo,
	revisionsData,
	sidePanel,
} from "../state";
import { formatExportTime, formatTime } from "./format";
import { Panel } from "./Panel";

function dimensionName(id: number | null): string {
	return currentMap.value?.dimensions.find((d) => d.id === id)?.name ?? "";
}

const dimensionSlugOf = (r: RevisionInfo) =>
	currentMap.value?.dimensions.find((d) => d.id === r.dimensionId)?.slug ??
	null;

/** Outlines the upload's area, but only if it is in the dimension being looked at. */
const outline = (r: RevisionInfo) =>
	r.dimensionId === null || dimensionSlugOf(r) === dimSlug.value
		? r.bbox
		: null;

/** Looks at the map as of the upload, in the dimension it was made in. */
function showRevision(r: RevisionInfo) {
	if (r.rev === null) return;
	const slug = dimensionSlugOf(r);
	if (slug && slug !== dimSlug.value) {
		if (
			!currentMap.value?.dimensions.some((d) => d.slug === slug && !d.archived)
		) {
			showNotice("That upload's dimension is archived.", "error");
			return;
		}
		selectDimension(slug);
	}
	setRev(r.rev);
	highlightBbox.value = r.bbox;
	if (r.bbox)
		mapView.value?.fitBounds(r.bbox, { padding: 120, closestZoom: 0 });
}

function describe(r: RevisionInfo): string {
	if (r.kind === "upload") {
		const files = `${r.fileCount} file${r.fileCount === 1 ? "" : "s"}`;
		return `Upload to ${dimensionName(r.dimensionId)}, ${files}`;
	}
	const target = revisionsData.value.find((x) => x.id === r.targetRevisionId);
	const what = target?.rev ? `revision ${target.rev}` : "an upload";
	return r.kind === "revert" ? `Reverted ${what}` : `Restored ${what}`;
}

function RevisionRow(props: {
	r: RevisionInfo;
	busy: boolean;
	onDelete: (r: RevisionInfo) => void;
}) {
	const { r } = props;
	const active = r.rev !== null && effectiveRev.value === r.rev;
	const inFlight = r.status === "pending" || r.status === "processing";
	const canView = r.rev !== null && r.status === "done";
	const canDelete =
		isModerator.value &&
		r.kind === "upload" &&
		(r.status === "done" || r.status === "failed");
	const canIsolate = r.kind === "upload" && r.status === "done";
	const isolated = isolatedUpload.value?.id === r.id;

	return (
		<li
			class={`revision ${active || isolated ? "active" : ""} ${r.reverted ? "reverted" : ""} ${r.status}`}
			onMouseEnter={() => {
				highlightBbox.value = outline(r);
			}}
			onMouseLeave={() => {
				highlightBbox.value = null;
			}}
		>
			<button
				type="button"
				class="plain revision-main"
				disabled={!canView}
				onClick={() => showRevision(r)}
			>
				<span class="rev-no">{r.rev !== null ? `#${r.rev}` : "…"}</span>
				<span class="rev-what">{describe(r)}</span>
				<span class="rev-meta">
					{r.authorName} · {formatTime(r.createdAt)}
					{r.exportedAt !== null &&
						` · exported ${formatExportTime(r.exportedAt)}`}
				</span>
			</button>
			<div class="rev-badges">
				{r.reverted && <span class="badge warn">reverted</span>}
				{inFlight && (
					<span class="badge">
						{deleting.value.get(r.id) ??
							(r.status === "pending" ? "queued" : "processing…")}
					</span>
				)}
				{r.status === "done" && r.error && (
					<span class="badge error" title={r.error}>
						{r.error}
					</span>
				)}
				{r.status === "failed" && (
					<span class="badge error" title={r.error ?? ""}>
						failed{r.error ? `: ${r.error}` : ""}
					</span>
				)}
			</div>
			{canIsolate && (
				<button
					type="button"
					class={`btn small ${isolated ? "active" : ""}`}
					aria-pressed={isolated}
					title="View only what this upload added, without the rest of the map"
					onClick={() => {
						if (isolated) isolatedUpload.value = null;
						else isolateUpload(r);
					}}
				>
					{isolated ? "Show all" : "Isolate"}
				</button>
			)}
			{canDelete && (
				<button
					type="button"
					class="btn small danger"
					disabled={props.busy}
					title="Remove this upload from the map and its history"
					onClick={() => props.onDelete(r)}
				>
					Delete
				</button>
			)}
		</li>
	);
}

/** Time slider over the map's revisions, plus the upload log, where moderators can delete uploads. */
export function HistoryPanel() {
	const head = currentMap.value?.map.headRev ?? 0;
	const current = effectiveRev.value;
	const [busy, setBusy] = useState(false);

	// Reload when a new head appears, and keep polling for jobs that are still running.
	useEffect(() => {
		void loadRevisions();
		const timer = setInterval(() => void loadRevisions(), 10_000);
		return () => clearInterval(timer);
	}, [head]);

	useEffect(
		() => () => {
			highlightBbox.value = null;
		},
		[],
	);

	const revisions = revisionsData.value;
	const at = revisions.find((r) => r.rev === current);

	const onDelete = async (r: RevisionInfo) => {
		const what = `the upload by ${r.authorName} (${formatTime(r.createdAt)})`;
		const detail =
			r.status === "failed"
				? "It only failed to process, so there is nothing to undo."
				: "It is removed from the map and from every past revision, and cannot be restored. To bring it back, upload the files again.";
		if (!confirm(`Delete ${what} permanently?\n${detail}`)) return;
		setBusy(true);
		await deleteUpload(r.id);
		setBusy(false);
	};

	return (
		<Panel title="History" onClose={() => (sidePanel.value = null)}>
			<div class="time-slider">
				<label class="label" for="rev-slider">
					Revision <b>{current}</b> of {head}
				</label>
				<input
					id="rev-slider"
					type="range"
					min={0}
					max={Math.max(head, 1)}
					step={1}
					value={current}
					disabled={head === 0}
					aria-valuetext={`Revision ${current} of ${head}`}
					onInput={(e) => setRev(Number(e.currentTarget.value))}
				/>
				<div class="muted slider-info">
					{head === 0
						? "Nothing has been uploaded yet."
						: current === 0
							? "Before the first upload"
							: at
								? `${describe(at)} · ${at.authorName} · ${formatTime(at.completedAt ?? at.createdAt)}`
								: ""}
				</div>
				<div class="group">
					<button
						type="button"
						class="btn"
						disabled={current <= 0}
						onClick={() => setRev(current - 1)}
					>
						◀ Older
					</button>
					<button
						type="button"
						class="btn"
						disabled={current >= head}
						onClick={() => setRev(current + 1)}
					>
						Newer ▶
					</button>
					<button
						type="button"
						class="btn"
						disabled={current >= head}
						onClick={() => setRev(null)}
					>
						Latest
					</button>
				</div>
			</div>

			<h3 class="section-title">Upload log</h3>
			<ul class="revisions">
				{revisions.map((r) => (
					<RevisionRow key={r.id} r={r} busy={busy} onDelete={onDelete} />
				))}
			</ul>
			{revisions.length === 0 && <p class="muted">No uploads yet.</p>}
		</Panel>
	);
}

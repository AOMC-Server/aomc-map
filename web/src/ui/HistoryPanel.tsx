import { useSignalEffect } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isolateUpload, mapView, setRev } from "../controller";
import type { Bounds } from "../map/geometry";
import { deleting, loadRevisions } from "../revisions";
import { settings, updateSettings } from "../settings";
import {
	currentMap,
	dimSlug,
	effectiveRev,
	highlightBbox,
	hoveredRevision,
	isolatedUpload,
	type RevisionInfo,
	rev,
	revisionsData,
	sidePanel,
	user,
	view,
} from "../state";
import {
	eventForRev,
	filterRevisions,
	groupByDay,
	outOfOrder,
	timelineEvents,
	viewBounds,
} from "../timeline";
import { deleteUploadFor } from "./DeleteUploadDialog";
import {
	formatEventDay,
	formatEventTime,
	formatRemaining,
	formatTime,
} from "./format";
import { Panel } from "./Panel";
import { pointAt, Timeline } from "./Timeline";

const inFlight = (r: RevisionInfo) =>
	r.status === "pending" || r.status === "processing";

/**
 * Looks at the map as of the upload, and at where it was made. With "In view" the camera stays
 * where it is, since moving it would change which uploads are listed.
 */
function showRevision(r: RevisionInfo) {
	if (r.rev === null) return;
	setRev(r.rev);
	highlightBbox.value = r.bbox;
	if (r.bbox && !settings.value.historyInView)
		mapView.value?.fitBounds(r.bbox, { padding: 120, closestZoom: 0 });
}

function describe(r: RevisionInfo): string {
	if (r.kind === "upload") {
		const files = `${r.fileCount} file${r.fileCount === 1 ? "" : "s"}`;
		return r.viaMod ? `${files} via mod` : files;
	}
	const target = revisionsData.value.find((x) => x.id === r.targetRevisionId);
	const what = target?.rev ? `revision ${target.rev}` : "an upload";
	return r.kind === "revert" ? `Reverted ${what}` : `Restored ${what}`;
}

/** Whether you may delete the upload now; the server decides, this only hides the button. */
function deletable(r: RevisionInfo, now: number) {
	return (
		r.kind === "upload" &&
		(r.status === "done" || r.status === "failed") &&
		r.canDelete &&
		(r.deletableUntil === null || now < r.deletableUntil)
	);
}

function RevisionRow(props: { r: RevisionInfo; odd: boolean; now: number }) {
	const { r } = props;
	const row = useRef<HTMLLIElement>(null);
	const active =
		r.rev !== null && rev.value !== null && effectiveRev.value === r.rev;
	const removing = deleting.value.get(r.id);
	const busy = inFlight(r) || removing !== undefined;
	const canView = r.rev !== null && r.status === "done" && !removing;
	const canDelete = deletable(r, props.now) && !busy;
	const canIsolate = r.kind === "upload" && r.status === "done" && !removing;
	const isolated = isolatedUpload.value?.id === r.id;
	const hover = hoveredRevision.value;
	const hovered = hover?.id === r.id;
	const pointedFromTimeline = hovered && hover?.from === "timeline";

	// Keep the row being looked at, or pointed at on the time line, in sight.
	useEffect(() => {
		if (active || pointedFromTimeline)
			row.current?.scrollIntoView({ block: "nearest" });
	}, [active, pointedFromTimeline]);

	return (
		<li
			ref={row}
			class={`revision ${active || isolated ? "active" : ""} ${hovered ? "hovered" : ""} ${r.reverted ? "reverted" : ""} ${r.status}`}
			onMouseEnter={() => pointAt(r, "log")}
			onMouseLeave={() => pointAt(null, "log")}
		>
			<button
				type="button"
				class="plain revision-main"
				disabled={!canView}
				onClick={() => showRevision(r)}
				title={canView ? "Look at the map as of this upload" : undefined}
			>
				<span class="rev-no">{r.rev !== null ? `#${r.rev}` : "…"}</span>
				<span class="rev-what">
					{r.authorName}
					<span class="rev-files"> · {describe(r)}</span>
				</span>
				<span class="rev-meta">
					{r.exportedAt !== null
						? `Exported ${formatTime(r.exportedAt)} · uploaded ${formatTime(r.createdAt)}`
						: `Uploaded ${formatTime(r.createdAt)}`}
				</span>
			</button>
			<div class="rev-badges">
				{props.odd && (
					<span
						class="badge warn"
						title="Uploaded after newer exports: the map at this revision also shows those."
					>
						late
					</span>
				)}
				{r.reverted && <span class="badge warn">reverted</span>}
				{busy && (
					<span class="badge">
						{removing ?? (r.status === "pending" ? "queued" : "processing…")}
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
						else isolateUpload(r, !settings.value.historyInView);
					}}
				>
					{isolated ? "Show all" : "Isolate"}
				</button>
			)}
			{canDelete && (
				<button
					type="button"
					class="btn small danger"
					title={
						r.deletableUntil !== null
							? `You can delete your upload for another ${formatRemaining(r.deletableUntil - props.now)}`
							: "Remove this upload from the map and its history"
					}
					onClick={() => {
						deleteUploadFor.value = r;
					}}
				>
					Delete
				</button>
			)}
		</li>
	);
}

/** The blocks in view, following the camera with a short delay. */
function useViewBounds(enabled: boolean): Bounds | null {
	const [bounds, setBounds] = useState<Bounds | null>(null);
	useSignalEffect(() => {
		const v = view.value;
		const mv = mapView.value;
		if (!enabled || !mv) return;
		const timer = setTimeout(() => setBounds(viewBounds(v, mv.getSize())), 150);
		return () => clearTimeout(timer);
	});
	if (!enabled) return null;
	const mv = mapView.peek();
	return bounds ?? (mv ? viewBounds(view.peek(), mv.getSize()) : null);
}

/** A time line over the dimension's uploads and the upload log; uploads can be deleted here. */
export function HistoryPanel() {
	const head = currentMap.value?.map.headRev ?? 0;
	const dim = dimSlug.value;
	const me = user.value;
	const { historyInView: inView, historyMineOnly } = settings.value;
	const mine = historyMineOnly && me !== null;
	const bounds = useViewBounds(inView);
	const [now, setNow] = useState(Date.now());

	// Reload when a new head or another dimension appears, and keep polling for running jobs.
	useEffect(() => {
		void loadRevisions();
		const timer = setInterval(() => {
			void loadRevisions();
			setNow(Date.now());
		}, 10_000);
		return () => clearInterval(timer);
	}, [head, dim]);

	useEffect(
		() => () => {
			highlightBbox.value = null;
			hoveredRevision.value = null;
		},
		[],
	);

	const all = revisionsData.value;
	const odd = useMemo(() => outOfOrder(all), [all]);
	const shown = useMemo(
		() =>
			filterRevisions(all, {
				inView: inView ? (bounds ?? null) : null,
				authorId: mine ? (me?.id ?? null) : null,
			}),
		[all, inView, bounds, mine, me?.id],
	);
	const events = useMemo(() => timelineEvents(shown), [shown]);
	const pending = useMemo(
		() => shown.filter((r) => r.kind === "upload" && inFlight(r)),
		[shown],
	);
	const days = useMemo(() => groupByDay(shown, formatEventDay), [shown]);

	const current =
		rev.value === null ? null : eventForRev(timelineEvents(all), rev.value);
	const uploads = all.filter((r) => r.kind === "upload").length;
	const filtered = shown.length !== all.length;

	return (
		<Panel
			title="History"
			class="history-panel"
			onClose={() => (sidePanel.value = null)}
			tabs={
				<div class="history-head">
					<div class="history-filters">
						<fieldset class="history-scope">
							<legend class="visually-hidden">Which uploads</legend>
							<div class="segmented">
								<button
									type="button"
									class={`btn small ${inView ? "" : "active"}`}
									aria-pressed={!inView}
									title="Every upload in this dimension"
									onClick={() => updateSettings({ historyInView: false })}
								>
									Everything
								</button>
								<button
									type="button"
									class={`btn small ${inView ? "active" : ""}`}
									aria-pressed={inView}
									title="Only uploads whose area is in view of the camera"
									onClick={() => updateSettings({ historyInView: true })}
								>
									In view
								</button>
							</div>
						</fieldset>
						{me && (
							<button
								type="button"
								class={`btn small ${mine ? "active" : ""}`}
								aria-pressed={mine}
								title="Only your own uploads"
								onClick={() => updateSettings({ historyMineOnly: !mine })}
							>
								Mine
							</button>
						)}
					</div>

					<div class="muted slider-info" aria-live="polite">
						{head === 0 ? (
							"Nothing has been uploaded yet."
						) : rev.value === null ? (
							<>
								Showing the <b>latest</b> map
								{filtered
									? ` · ${shown.length} of ${all.length} uploads listed`
									: ` · ${uploads} upload${uploads === 1 ? "" : "s"}`}
							</>
						) : current ? (
							<>
								As of <b>{formatEventTime(current)}</b> · #{current.rev} by{" "}
								{current.authorName}
							</>
						) : (
							"Before the first upload"
						)}
					</div>

					<Timeline
						events={events}
						pending={pending}
						outOfOrder={odd}
						describe={describe}
					/>
				</div>
			}
		>
			<h3 class="section-title">Upload log</h3>
			{days.map((g) => (
				<section key={g.day} class="rev-day">
					<h4 class="rev-day-title">
						{g.day}
						<span class="muted">
							{" "}
							· {g.items.length} upload{g.items.length === 1 ? "" : "s"}
						</span>
					</h4>
					<ul class="revisions">
						{g.items.map((r) => (
							<RevisionRow key={r.id} r={r} odd={odd.has(r.id)} now={now} />
						))}
					</ul>
				</section>
			))}
			{shown.length === 0 && (
				<p class="muted">
					{all.length === 0
						? "Nothing has been uploaded to this dimension yet."
						: inView && mine
							? "None of your uploads are in view. Zoom out, or switch to Everything."
							: inView
								? "No uploads in view. Zoom out, or switch to Everything."
								: "You haven't uploaded anything to this dimension."}
				</p>
			)}
		</Panel>
	);
}

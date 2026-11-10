import { useEffect, useState } from "preact/hooks";
import { mapView, setRev } from "../controller";
import { loadRevisions, revertUpload } from "../revisions";
import {
	currentMap,
	effectiveRev,
	highlightBbox,
	historyPanelOpen,
	isModerator,
	type RevisionInfo,
	revisionsData,
} from "../state";
import { formatTime } from "./format";

function dimensionName(id: number | null): string {
	return currentMap.value?.dimensions.find((d) => d.id === id)?.name ?? "";
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
	onRevert: (r: RevisionInfo, kind: "revert" | "unrevert") => void;
}) {
	const { r } = props;
	const active = r.rev !== null && effectiveRev.value === r.rev;
	const inFlight = r.status === "pending" || r.status === "processing";
	const canView = r.rev !== null && r.status === "done";
	const canRevert =
		isModerator.value && r.kind === "upload" && r.status === "done";

	return (
		<li
			class={`revision ${active ? "active" : ""} ${r.reverted ? "reverted" : ""} ${r.status}`}
			onMouseEnter={() => {
				highlightBbox.value = r.bbox;
			}}
			onMouseLeave={() => {
				highlightBbox.value = null;
			}}
		>
			<button
				type="button"
				class="revision-main"
				disabled={!canView}
				onClick={() => {
					if (r.rev === null) return;
					setRev(r.rev);
					highlightBbox.value = r.bbox;
					if (r.bbox)
						mapView.value?.fitBounds(r.bbox, { padding: 120, closestZoom: 0 });
				}}
			>
				<span class="rev-no">{r.rev !== null ? `#${r.rev}` : "…"}</span>
				<span class="rev-what">{describe(r)}</span>
				<span class="rev-meta">
					{r.authorName} · {formatTime(r.createdAt)}
				</span>
			</button>
			<div class="rev-badges">
				{r.reverted && <span class="badge warn">reverted</span>}
				{inFlight && (
					<span class="badge">
						{r.status === "pending" ? "queued" : "processing…"}
					</span>
				)}
				{r.status === "failed" && (
					<span class="badge error" title={r.error ?? ""}>
						failed{r.error ? `: ${r.error}` : ""}
					</span>
				)}
			</div>
			{canRevert && (
				<button
					type="button"
					class="btn small"
					disabled={props.busy}
					onClick={() => props.onRevert(r, r.reverted ? "unrevert" : "revert")}
				>
					{r.reverted ? "Restore" : "Revert"}
				</button>
			)}
		</li>
	);
}

/** Time slider over the map's revisions, plus the upload log with moderator revert/restore. */
export function HistoryPanel() {
	const head = currentMap.value?.map.headRev ?? 0;
	const current = effectiveRev.value;
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void loadRevisions();
		const timer = setInterval(() => void loadRevisions(), 10_000);
		return () => {
			clearInterval(timer);
			highlightBbox.value = null;
		};
	}, []);

	useEffect(() => {
		void head;
		void loadRevisions();
	}, [head]);

	const revisions = revisionsData.value;
	const at = revisions.find((r) => r.rev === current);

	const onRevert = async (r: RevisionInfo, kind: "revert" | "unrevert") => {
		const verb = kind === "revert" ? "Revert" : "Restore";
		const detail =
			kind === "revert"
				? "Its tiles disappear from the current map (older revisions still show it)."
				: "Its tiles come back on the current map.";
		if (
			!confirm(
				`${verb} the upload by ${r.authorName} (${formatTime(r.createdAt)})?\n${detail}`,
			)
		)
			return;
		setBusy(true);
		await revertUpload(r.id, kind);
		setBusy(false);
	};

	return (
		<aside class="panel" aria-label="History">
			<header class="panel-head">
				<h2>History</h2>
				<button
					type="button"
					class="btn"
					aria-label="Close history"
					onClick={() => (historyPanelOpen.value = false)}
				>
					×
				</button>
			</header>
			<div class="panel-body">
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
						<RevisionRow key={r.id} r={r} busy={busy} onRevert={onRevert} />
					))}
				</ul>
				{revisions.length === 0 && <p class="muted">No uploads yet.</p>}
			</div>
		</aside>
	);
}

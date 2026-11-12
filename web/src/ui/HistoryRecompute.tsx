import type { InferResponseType } from "hono/client";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, run, showNotice } from "../api";
import { refreshMap } from "../controller";
import { subscribe } from "../events";
import { formatProgress, formatTime } from "./format";

type Status = InferResponseType<typeof api.api.admin.history.$get, 200>;

const running = (s: Status | null) =>
	s?.recompute?.status === "pending" || s?.recompute?.status === "processing";

/** Owners: rebuild the history in export order, so no "late" upload shows newer exports. */
export function HistoryRecompute() {
	const [status, setStatus] = useState<Status | null>(null);
	const [starting, setStarting] = useState(false);

	/** The status of the recompute as last seen, to tell when one ends. */
	const seen = useRef<Status["recompute"]>(null);

	/** Takes a new state of the recompute; when one just ended, picks up the new revision numbers. */
	const apply = (next: Status["recompute"]) => {
		const was = seen.current?.status;
		seen.current = next;
		if (was !== "pending" && was !== "processing") return;
		if (next?.status === "done") {
			showNotice("History recomputed in export order.");
			void refreshMap();
			void load();
		} else if (next?.status === "failed") {
			showNotice(
				`Recomputing history failed: ${next.error ?? "unknown error"}`,
				"error",
			);
		}
	};

	const load = async () => {
		const res = await attempt(() => api.api.admin.history.$get());
		if (!res.ok) return null;
		setStatus(res.body);
		apply(res.body.recompute);
		return res.body;
	};

	useEffect(
		() =>
			subscribe("recompute", {
				onEvent: ({ recompute }) => {
					setStatus((cur) => (cur ? { ...cur, recompute } : cur));
					apply(recompute);
				},
				poll: () => void load(),
				pollMs: 2000,
			}),
		[],
	);

	useEffect(() => {
		void load();
	}, []);

	const busy = running(status);

	const start = async () => {
		if (
			!confirm(
				"Recompute the whole history in export order? Every upload gets a new revision number, so links to a past revision will show a different moment afterwards. The current map does not change.",
			)
		)
			return;
		setStarting(true);
		try {
			if (await run(() => api.api.admin.history.recompute.$post()))
				await load();
		} finally {
			setStarting(false);
		}
	};

	const r = status?.recompute;
	const p = r?.progress;
	return (
		<section class="history-recompute">
			<h3 class="section-title">History</h3>
			<p class="muted hint">
				An old export uploaded after newer ones goes underneath them on the map,
				but in the history it is only added when it was uploaded, so looking at
				its date also shows the newer exports (the history panel marks such
				uploads <i>late</i>). Recomputing rebuilds every past revision in export
				order, across all dimensions. It runs in the background queue; uploads
				wait until it is done.
			</p>
			{status && (
				<p>
					{status.lateUploads === 0
						? "Every upload is in export order."
						: `${status.lateUploads} upload${status.lateUploads === 1 ? " is" : "s are"} out of export order.`}
				</p>
			)}
			{busy ? (
				<div class="progress-wrap">
					<div
						class="progress"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={
							p?.total ? Math.round(((p.done ?? 0) / p.total) * 100) : undefined
						}
					>
						<div
							class={`bar ${p?.total ? "" : "indeterminate"}`}
							style={
								p?.total
									? { width: `${((p.done ?? 0) / p.total) * 100}%` }
									: undefined
							}
						/>
					</div>
					<div class="muted">
						{r?.status === "pending"
							? "Waiting for the running uploads and deletions to finish…"
							: p
								? formatProgress(p.message, p.done, p.total)
								: "Starting…"}
					</div>
					<p class="muted hint">
						This can take a few minutes on a large map. You can leave this page;
						it keeps running. The map stays usable, but new uploads and
						deletions wait until it is done.
					</p>
				</div>
			) : (
				<>
					{r?.status === "failed" && (
						<p class="error-text">
							The last recompute failed: {r.error ?? "unknown error"}
						</p>
					)}
					{r?.status === "done" && r.completedAt !== null && (
						<p class="muted hint">
							Last recomputed {formatTime(r.completedAt)}.
						</p>
					)}
					<button
						type="button"
						class="btn"
						disabled={starting || !status}
						onClick={start}
					>
						Recompute history
					</button>
				</>
			)}
		</section>
	);
}

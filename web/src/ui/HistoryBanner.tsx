import { setRev } from "../controller";
import {
	currentMap,
	effectiveRev,
	isolatedUpload,
	rev,
	revisionsData,
} from "../state";
import { formatTime } from "./format";

/** Always visible while looking at the past, so it is clear that edits are off. */
export function HistoryBanner() {
	const only = isolatedUpload.value;
	if (only) {
		return (
			<div class="history-banner" role="status">
				<span>
					Viewing only the upload by <b>{only.authorName}</b> from{" "}
					{formatTime(only.createdAt)}
					{" · "}the rest of the map is hidden
				</span>
				<button
					type="button"
					class="btn primary small"
					onClick={() => {
						isolatedUpload.value = null;
					}}
				>
					Show everything
				</button>
			</div>
		);
	}
	if (rev.value === null) return null;
	const head = currentMap.value?.map.headRev ?? 0;
	const current = effectiveRev.value;
	const r = revisionsData.value.find((x) => x.rev === current);
	return (
		<div class="history-banner" role="status">
			<span>
				Viewing revision <b>{current}</b> of {head}
				{r ? ` · ${formatTime(r.completedAt ?? r.createdAt)}` : ""}
				{" · "}editing is off
			</span>
			<button
				type="button"
				class="btn primary small"
				onClick={() => setRev(null)}
			>
				Back to latest
			</button>
		</div>
	);
}

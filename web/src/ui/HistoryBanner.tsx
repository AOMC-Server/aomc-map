import type { ComponentChildren } from "preact";
import { setRev } from "../controller";
import {
	currentMap,
	effectiveRev,
	isolatedUpload,
	rev,
	revisionsData,
} from "../state";
import { formatEventTime } from "./format";

function BossBar(props: {
	title: ComponentChildren;
	fill: number;
	color: "yellow" | "purple";
	action: string;
	onAction: () => void;
}) {
	return (
		<div class="bossbar-wrap">
			<div class="bossbar" role="status">
				<div class="bossbar-main">
					<div class="bossbar-title">{props.title}</div>
					<div class={`bossbar-track ${props.color}`}>
						<span style={{ width: `${Math.round(props.fill * 100)}%` }} />
					</div>
				</div>
				<button type="button" class="btn small" onClick={props.onAction}>
					{props.action}
				</button>
			</div>
		</div>
	);
}

/** Always visible while looking at the past, so it is clear that edits are off. */
export function HistoryBanner() {
	const only = isolatedUpload.value;
	if (only) {
		return (
			<BossBar
				color="purple"
				fill={1}
				title={
					<>
						Only the upload by <b>{only.authorName}</b> ·{" "}
						{formatEventTime(only)}
					</>
				}
				action="Show everything"
				onAction={() => {
					isolatedUpload.value = null;
				}}
			/>
		);
	}
	if (rev.value === null) return null;
	const head = currentMap.value?.map.headRev ?? 0;
	const current = effectiveRev.value;
	const r = revisionsData.value.find((x) => x.rev === current);
	return (
		<BossBar
			color="yellow"
			fill={head ? current / head : 0}
			title={
				r ? (
					<>
						As of <b>{formatEventTime(r)}</b> · #{current} by {r.authorName} ·
						editing is off
					</>
				) : (
					<>
						Revision <b>{current}</b> of {head} · editing is off
					</>
				)
			}
			action="Back to latest"
			onAction={() => setRev(null)}
		/>
	);
}

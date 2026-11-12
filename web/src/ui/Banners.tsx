import { canManage } from "@aomc/shared/roles";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { setRev } from "../controller";
import { setMaintenance } from "../sharing";
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
	color: "yellow" | "purple" | "maintenance";
	action?: string;
	onAction?: () => void;
}) {
	return (
		<div class={`bossbar ${props.color}`} role="status">
			<div class="bossbar-main">
				<div class="bossbar-title">{props.title}</div>
				<div class={`bossbar-track ${props.color}`}>
					<span style={{ width: `${Math.round(props.fill * 100)}%` }} />
				</div>
			</div>
			{props.action && (
				<button type="button" class="btn small" onClick={props.onAction}>
					{props.action}
				</button>
			)}
		</div>
	);
}

/** Always visible while the map is in maintenance, so it is clear why nothing can be changed. */
function MaintenanceBar() {
	const detail = currentMap.value;
	const [busy, setBusy] = useState(false);
	if (!detail?.map.maintenance) return null;
	const owner = canManage(detail.role);
	return (
		<BossBar
			color="maintenance"
			fill={1}
			title={
				owner ? (
					<>
						<b>Maintenance</b> · only owners can make changes
					</>
				) : (
					<>
						<b>Maintenance</b> · the map is read only for now
					</>
				)
			}
			action={owner ? (busy ? "Turning off…" : "Turn off") : undefined}
			onAction={async () => {
				if (busy) return;
				setBusy(true);
				try {
					await setMaintenance(false);
				} finally {
					setBusy(false);
				}
			}}
		/>
	);
}

/** The bars at the top of the map: maintenance, and what point in time is shown. */
export function Banners() {
	return (
		<div class="bossbar-wrap">
			<MaintenanceBar />
			<HistoryBanner />
		</div>
	);
}

/** Always visible while looking at the past, so it is clear that edits are off. */
function HistoryBanner() {
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

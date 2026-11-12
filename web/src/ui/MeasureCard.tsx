import { showNotice } from "../api";
import {
	activeTool,
	canEditMap,
	centerBlock,
	currentScale,
	dimSlug,
	editor,
	isLayerFull,
	layersData,
	noHover,
	visibleDimensions,
} from "../state";
import {
	clearMeasure,
	featureFromMeasure,
	measureAt,
	measuredShape,
	measureShape,
	measureStats,
	measureSummary,
} from "../tools/measure";
import {
	formatBlocks,
	formatDuration,
	TRAVEL_SPEEDS,
} from "../tools/measureMath";

const round1 = (n: number) => Math.round(n * 10) / 10;

async function copySummary() {
	const shape = measuredShape();
	if (!shape) return;
	try {
		await navigator.clipboard.writeText(measureSummary(shape.graph).join("\n"));
		showNotice("Measurement copied");
	} catch {
		showNotice("Copy failed", "error");
	}
}

function Row(props: { label: string; value: string }) {
	return (
		<div class="stat">
			<span class="stat-label">{props.label}</span>
			<span class="stat-value">{props.value}</span>
		</div>
	);
}

/** The numbers of the measure tool: distance, direction, the same distance in other dimensions and travel times. */
export function MeasureCard() {
	if (activeTool.value !== "measure") return null;
	const stats = measureStats.value;
	const scale = currentScale.value;
	const others =
		stats && scale !== null
			? visibleDimensions.value.filter(
					(d) =>
						d.slug !== dimSlug.value && d.scale !== null && d.scale !== scale,
				)
			: [];
	const shape = measureShape.state.value;
	const placed = shape?.points.length ?? 0;
	const touch = noHover.value;
	const finished = shape?.mode === "placed";
	const measured = measuredShape();
	const canSave =
		canEditMap.value &&
		editor.value === null &&
		layersData.value.some((l) => l.canEdit && !isLayerFull(l));

	return (
		<aside class="measure-card" aria-label="Measure">
			<header class="panel-head">
				<h2>Measure</h2>
				<button
					type="button"
					class="btn small close"
					aria-label="Stop measuring"
					onClick={() => {
						activeTool.value = "none";
					}}
				>
					×
				</button>
			</header>
			<div class="measure-body">
				{!stats ? (
					<p class="muted">
						{touch
							? "Move the map to put the crosshair on a spot, then tap Add point. Keep adding points to measure a path."
							: "Click the map to place a point, then keep clicking to measure a path."}
					</p>
				) : (
					<>
						<div class="measure-total">
							{formatBlocks(stats.total)}{" "}
							<small>{stats.area !== null ? "blocks around" : "blocks"}</small>
						</div>
						{stats.segments.length === 0 && (
							<p class="muted">
								{touch
									? "Move the crosshair to the next spot and add a point."
									: "Click to place the next point."}
							</p>
						)}
						{stats.area !== null && (
							<Row label="Area" value={`${formatBlocks(stats.area)} blocks²`} />
						)}
						{stats.segments.length > 0 && stats.ends && (
							<>
								{stats.segments.length > 1 && (
									<Row
										label={`Straight line`}
										value={`${formatBlocks(stats.ends.straight)} blocks`}
									/>
								)}
								<Row
									label="Δx / Δz"
									value={`${stats.ends.dx} / ${stats.ends.dz}`}
								/>
								{stats.ends.facing && (
									<Row
										label="Facing"
										value={`${stats.ends.facing.name} (yaw ${round1(stats.ends.facing.yaw)}°)`}
									/>
								)}
							</>
						)}
						{others.length > 0 && stats.total > 0 && (
							<>
								<h3 class="section-title">In other dimensions</h3>
								{others.map((d) => (
									<Row
										key={d.slug}
										label={d.name}
										value={`${formatBlocks((stats.total * (scale as number)) / (d.scale as number))} blocks`}
									/>
								))}
							</>
						)}
						{stats.total > 0 && (
							<>
								<h3 class="section-title">Travel time</h3>
								{TRAVEL_SPEEDS.map((t) => (
									<Row
										key={t.label}
										label={t.label}
										value={formatDuration(stats.total / t.speed)}
									/>
								))}
							</>
						)}
					</>
				)}
				<div class="group measure-actions">
					{touch && (
						<button
							type="button"
							class="btn small primary"
							// The crosshair is still on the point being drawn from: another would add nothing.
							disabled={
								finished ||
								(shape?.selected != null &&
									shape.points[shape.selected]?.[0] === centerBlock.value.x &&
									shape.points[shape.selected]?.[1] === centerBlock.value.z)
							}
							onClick={() => measureAt(centerBlock.value)}
						>
							Add point
						</button>
					)}
					{touch && !finished && measured && (
						<button
							type="button"
							class="btn small"
							onClick={() => measureShape.finish()}
						>
							Done
						</button>
					)}
					{touch && measureShape.canCloseLine() && (
						<button
							type="button"
							class="btn small"
							onClick={() => measureShape.closeLine()}
						>
							Close shape
						</button>
					)}
					<button
						type="button"
						class="btn small"
						disabled={placed === 0}
						title={finished ? "Go back to adding points" : undefined}
						onClick={finished ? measureShape.resume : measureShape.undoPoint}
					>
						{finished ? "Resume" : "Undo"}
					</button>
					<button
						type="button"
						class="btn small"
						disabled={placed === 0}
						onClick={clearMeasure}
					>
						Clear
					</button>
					<button
						type="button"
						class="btn small"
						disabled={!measured}
						onClick={() => void copySummary()}
					>
						Copy
					</button>
				</div>
				{measured && canEditMap.value && (
					<div class="group measure-actions">
						<button
							type="button"
							class="btn small"
							disabled={!canSave}
							title={
								canSave
									? "Keep this as a line in a layer"
									: "Needs a layer you can add to, and no feature being edited"
							}
							onClick={() => featureFromMeasure("line")}
						>
							Save as line
						</button>
						{measured.loop && (
							<button
								type="button"
								class="btn small"
								disabled={!canSave}
								title={
									canSave
										? "Keep this as an area in a layer"
										: "Needs a layer you can add to, and no feature being edited"
								}
								onClick={() => featureFromMeasure("polygon")}
							>
								Save as area
							</button>
						)}
					</div>
				)}
				<p class="hint">
					{finished
						? "Drag a point to move it, or click one to draw on from it (from the middle, that branches). Right-click a point to remove it. Clear starts over."
						: touch
							? "Tap a point to join the path to it (the first closes a shape), or the last to finish. Drag a point to move it."
							: "Click another point to join it (the first closes a shape), or the last point (Enter or Esc) to finish. Hold Shift to snap to straight lines. Drag a point to move it, right-click one to remove it."}
				</p>
			</div>
		</aside>
	);
}

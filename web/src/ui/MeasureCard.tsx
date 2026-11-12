import { showNotice } from "../api";
import {
	activeTool,
	centerBlock,
	currentScale,
	dimSlug,
	noHover,
	visibleDimensions,
} from "../state";
import {
	clearMeasure,
	clickMeasure,
	finishMeasure,
	formatBlocks,
	measureFinish,
	measurePoints,
	measureStats,
	undoMeasure,
} from "../tools/measure";
import {
	formatDuration,
	pathLength,
	polygonArea,
	samePoint,
	segmentIndices,
	TRAVEL_SPEEDS,
} from "../tools/measureMath";

const round1 = (n: number) => Math.round(n * 10) / 10;

async function copySummary() {
	const points = measurePoints.value;
	const closed = measureFinish.value === "shape";
	const lengths = segmentIndices(points.length, closed).map(([a, b]) =>
		pathLength([points[a], points[b]] as typeof points),
	);
	const total = lengths.reduce((sum, l) => sum + l, 0);
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last) return;
	const lines = closed
		? [
				`Perimeter: ${formatBlocks(total)} blocks`,
				`Area: ${formatBlocks(polygonArea(points))} blocks²`,
				`Corners: ${points.map((p) => `${p.x}, ${p.z}`).join(" → ")}`,
			]
		: [
				`Distance: ${formatBlocks(total)} blocks`,
				`From ${first.x}, ${first.z} to ${last.x}, ${last.z}`,
			];
	if (lengths.length > 1)
		lines.push(`Segments: ${lengths.map(formatBlocks).join(" + ")}`);
	try {
		await navigator.clipboard.writeText(lines.join("\n"));
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
	const placed = measurePoints.value.length;
	const touch = noHover.value;
	const finished = measureFinish.value;
	const closed = stats?.closed ?? false;

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
						{stats.segments.length > 0 && !closed && (
							<>
								{stats.segments.length > 1 && (
									<Row
										label={`Straight line`}
										value={`${formatBlocks(stats.straight)} blocks`}
									/>
								)}
								<Row label="Δx / Δz" value={`${stats.dx} / ${stats.dz}`} />
								{stats.facing && (
									<Row
										label="Facing"
										value={`${stats.facing.name} (yaw ${round1(stats.facing.yaw)}°)`}
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
							// The crosshair is still on the last point: another would add nothing.
							disabled={
								finished !== null ||
								samePoint(measurePoints.value.at(-1) ?? null, centerBlock.value)
							}
							onClick={() => clickMeasure(centerBlock.value)}
						>
							Add point
						</button>
					)}
					{touch && finished === null && placed >= 2 && (
						<button
							type="button"
							class="btn small"
							onClick={() => finishMeasure("line")}
						>
							Done
						</button>
					)}
					{touch && finished === null && placed >= 3 && (
						<button
							type="button"
							class="btn small"
							onClick={() => finishMeasure("shape")}
						>
							Close shape
						</button>
					)}
					<button
						type="button"
						class="btn small"
						disabled={placed === 0}
						title={finished ? "Go back to adding points" : undefined}
						onClick={undoMeasure}
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
						disabled={placed < 2}
						onClick={() => void copySummary()}
					>
						Copy
					</button>
				</div>
				<p class="hint">
					{finished
						? "Drag a point to move it. Resume to add more points, or Clear to start over."
						: touch
							? "Tap the first point to close the shape, or the last to finish. Drag a point to move it."
							: "Click the first point to close the shape, or the last point (or press Enter) to finish. Hold Shift to snap to straight lines. Drag a point to move it."}
				</p>
			</div>
		</aside>
	);
}

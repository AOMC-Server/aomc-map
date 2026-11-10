import { activeTool, cursor, view } from "../state";
import { clearCopy, copiedPoints, copyStatus } from "../tools/copyCoords";
import { clearMeasure, measurePoints, measureResult } from "../tools/measure";

/** Human readable scale: "1 block = 4 px" when magnified, "1 px = 8 blocks" when zoomed out. */
export function describeScale(zoom: number): string {
	const blocksPerPx = 2 ** zoom;
	if (blocksPerPx < 1) {
		const pxPerBlock = 1 / blocksPerPx;
		return `1 block = ${trim(pxPerBlock)} px`;
	}
	return `1 px = ${trim(blocksPerPx)} block${blocksPerPx === 1 ? "" : "s"}`;
}

const trim = (n: number) =>
	n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;

export function StatusBar() {
	const c = cursor.value;
	const tool = activeTool.value;
	const result = measureResult.value;
	return (
		<footer class="statusbar">
			<span class="readout">{c ? `x ${c.x}  z ${c.z}` : "x –  z –"}</span>
			<span class="scale">{describeScale(view.value.zoom)}</span>

			{tool === "measure" && (
				<span class="tool-info">
					{result
						? `Δx ${result.dx}  Δz ${result.dz}  distance ${result.distance.toFixed(1)}`
						: measurePoints.value.length === 1
							? "Click a second point"
							: "Click a first point"}
					{measurePoints.value.length > 0 && (
						<button type="button" class="link" onClick={clearMeasure}>
							clear
						</button>
					)}
				</span>
			)}
			{tool === "copy" && (
				<span class="tool-info">
					{copiedPoints.value.length === 0
						? "Click the map to copy coordinates"
						: copyStatus.value === "failed"
							? "Clipboard unavailable"
							: `${copiedPoints.value.length} copied`}
					{copiedPoints.value.length > 0 && (
						<button type="button" class="link" onClick={clearCopy}>
							clear
						</button>
					)}
				</span>
			)}
		</footer>
	);
}

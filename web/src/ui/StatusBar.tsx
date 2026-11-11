import { settings } from "../settings";
import { currentScale, cursor, view } from "../state";

/** Human readable scale: "1 block = 4 px" when magnified, "1 px = 8 blocks" when zoomed out. */
function describeScale(zoom: number): string {
	const blocksPerPx = 2 ** zoom;
	if (blocksPerPx < 1) {
		const pxPerBlock = 1 / blocksPerPx;
		return `1 block = ${trim(pxPerBlock)} px`;
	}
	return `1 px = ${trim(blocksPerPx)} block${blocksPerPx === 1 ? "" : "s"}`;
}

const trim = (n: number) =>
	n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;

/** Cursor position and zoom scale, in a corner of the map. */
export function StatusBar() {
	const c = cursor.value;
	const scale = currentScale.value;
	// In a scaled dimension (the Nether) also show where the cursor is in overworld coordinates.
	const prefs = settings.value;
	const equivalent =
		prefs.showOverworldEquivalent && c && scale !== null && scale !== 1
			? { x: Math.round(c.x * scale), z: Math.round(c.z * scale) }
			: null;
	if (!prefs.showCoordinates && !equivalent && !prefs.showScale) return null;
	return (
		<footer class="debug">
			{prefs.showCoordinates && (
				<span class="line readout">Position: {c ? `${c.x}, ${c.z}` : "–"}</span>
			)}
			{equivalent && (
				<span class="line equivalent" title="The same place in the overworld">
					Overworld: {equivalent.x}, {equivalent.z}
				</span>
			)}
			{prefs.showScale && (
				<span class="line scale">Zoom: {describeScale(view.value.zoom)}</span>
			)}
		</footer>
	);
}

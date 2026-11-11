import { type Size, screenToBlock, type View } from "@aomc/shared/view";
import type { Bounds } from "./geometry";

/** The blocks in view, grown by `margin` blocks on every side. */
export function viewportBlocks(view: View, size: Size, margin = 0): Bounds {
	const tl = screenToBlock(view, size, 0, 0);
	const br = screenToBlock(view, size, size.width, size.height);
	return {
		minX: tl.x - margin,
		minZ: tl.z - margin,
		maxX: br.x + margin,
		maxZ: br.z + margin,
	};
}

import type { Point as BlockPoint } from "@aomc/shared/features";
import { computed } from "@preact/signals";
import type { MapView } from "../map/MapView";
import {
	activeTool,
	contextMenu,
	editor,
	isLayerFull,
	isLayerHidden,
	lastEditLayer,
	layersData,
	noHover,
	popup,
	setLayersHidden,
} from "../state";
import { drawing } from "./draw";
import { blockCenter } from "./handles";
import {
	dropLoose,
	type LineGraph,
	loopOf,
	pathsFromGraph,
	simplePath,
} from "./lineGraph";
import { facing, formatBlocks, type Point, polygonArea } from "./measureMath";
import { labelBox } from "./overlay";
import { createShapeEditor } from "./shape";

export type { Point };

/**
 * The measure tool: the shape editor (see shape.ts) in white, so a measurement can branch, close
 * into a loop and have points moved or removed like a line, plus the numbers and the lengths
 * written on the map.
 */
export const measureShape = createShapeEditor({
	style: {
		line: "#fff",
		first: "#52a535",
		markFirst: true,
		fillLoops: true,
	},
	// The feature editor, when open, has the pointer and the keys.
	active: () => activeTool.value === "measure" && drawing.value === null,
	// On touch screens points go at the crosshair (the measure card's Add point) instead.
	pointerAims: () => !noHover.value,
	escapeClears: true,
});

const stopTool = () => {
	activeTool.value = "none";
};

/** Starts an empty measurement, if there is none yet. */
export function startMeasure() {
	if (!measureShape.state.peek()) measureShape.start("line", [], stopTool);
}

/** Drops the measurement; the tool was closed. */
export function endMeasure() {
	measureShape.stop();
	measureShape.setHover(null);
}

/** Starts a new measurement with its first point at `p`. */
export function measureFrom(p: Point) {
	activeTool.value = "measure";
	measureShape.start("line", [[[p.x, p.z]]], stopTool);
}

export function clearMeasure() {
	if (measureShape.state.peek()) measureShape.start("line", [], stopTool);
}

/** Puts a point at a block, as a click there would. */
export const measureAt = (p: Point) => measureShape.place([p.x, p.z]);

export type MeasureStats = {
	/** Length of each segment. */
	segments: number[];
	/** Length of everything. */
	total: number;
	/** From one end to the other, as the crow flies; only for a single path. */
	ends: {
		straight: number;
		dx: number;
		dz: number;
		facing: { name: string; yaw: number } | null;
	} | null;
	/** The last segment is the one to the cursor rather than a placed one. */
	preview: boolean;
	/** The line is one closed loop. */
	closed: boolean;
	/** Area enclosed by a closed loop (or by the one the cursor would close), in square blocks. */
	area: number | null;
};

const asXZ = ([x, z]: BlockPoint): Point => ({ x, z });

/** The numbers of a measurement. */
export function measureOf(g: LineGraph, preview = false): MeasureStats {
	const segments = g.edges.map(([a, b]) => {
		const p = g.points[a] as BlockPoint;
		const q = g.points[b] as BlockPoint;
		return Math.hypot(q[0] - p[0], q[1] - p[1]);
	});
	const loop = loopOf(g);
	const path = loop ? null : simplePath(g);
	let ends: MeasureStats["ends"] = null;
	if (path) {
		const first = path[0] as BlockPoint;
		const last = path.at(-1) as BlockPoint;
		const dx = last[0] - first[0];
		const dz = last[1] - first[1];
		ends = {
			straight: Math.hypot(dx, dz),
			dx,
			dz,
			facing: dx === 0 && dz === 0 ? null : facing(dx, dz),
		};
	}
	return {
		segments,
		total: segments.reduce((sum, length) => sum + length, 0),
		ends,
		preview,
		closed: loop !== null,
		area: loop ? polygonArea(loop.map(asXZ)) : null,
	};
}

/** Numbers for the measure card, including the segment to the cursor while aiming. */
export const measureStats = computed<MeasureStats | null>(() => {
	const aim = measureShape.aimed.value;
	if (!aim || aim.points.length === 0) return null;
	return measureOf(aim, aim.preview);
});

/** The lines the card's Copy puts on the clipboard. */
export function measureSummary(g: LineGraph): string[] {
	const stats = measureOf(g);
	const lengths = stats.segments.map(formatBlocks);
	let lines: string[];
	const loop = loopOf(g);
	const path = loop ? null : simplePath(g);
	if (loop)
		lines = [
			`Perimeter: ${formatBlocks(stats.total)} blocks`,
			`Area: ${formatBlocks(stats.area ?? 0)} blocks²`,
			`Corners: ${loop.map(([x, z]) => `${x}, ${z}`).join(" → ")}`,
		];
	else if (path) {
		const first = path[0] as BlockPoint;
		const last = path.at(-1) as BlockPoint;
		lines = [
			`Distance: ${formatBlocks(stats.total)} blocks`,
			`From ${first[0]}, ${first[1]} to ${last[0]}, ${last[1]}`,
		];
	} else
		lines = [
			`Total length: ${formatBlocks(stats.total)} blocks`,
			`Points: ${g.points.map(([x, z]) => `${x}, ${z}`).join("; ")}`,
		];
	if (lengths.length > 1) lines.push(`Segments: ${lengths.join(" + ")}`);
	return lines;
}

/** What the measurement can become: a line, and an area when it is a closed loop. */
export function measuredShape() {
	const d = measureShape.state.value;
	if (d?.type !== "line") return null;
	const g = dropLoose(d);
	if (g.edges.length === 0) return null;
	return { graph: g, loop: loopOf(g) };
}

/**
 * Opens the feature editor on the measured shape, as a line or (for a closed loop) an area, in
 * the layer last used or else the first one that can take it. Returns false when there is none.
 */
export function featureFromMeasure(type: "line" | "polygon"): boolean {
	const shape = measuredShape();
	if (!shape) return false;
	const paths =
		type === "polygon"
			? shape.loop
				? [shape.loop]
				: null
			: pathsFromGraph(shape.graph);
	if (!paths) return false;
	const layers = layersData.value.filter((l) => l.canEdit && !isLayerFull(l));
	const layer = layers.find((l) => l.id === lastEditLayer.value) ?? layers[0];
	if (!layer) return false;
	if (isLayerHidden(layer)) setLayersHidden([layer], false);
	activeTool.value = "none";
	popup.value = null;
	contextMenu.value = null;
	editor.value = { mode: "create", layerId: layer.id, shape: { type, paths } };
	return true;
}

/** Overlay: the shape, the length of each segment, and the total. */
export function drawMeasure(ctx: CanvasRenderingContext2D, map: MapView) {
	measureShape.draw(ctx, map);
	const aim = measureShape.aimed.value;
	const stats = measureStats.value;
	if (!aim || !stats) return;
	const at = (i: number) => blockCenter(map, asXZ(aim.points[i] as BlockPoint));

	ctx.save();
	// Segment lengths at their midpoints, where there is room for them.
	aim.edges.forEach(([a, b], i) => {
		const pa = at(a);
		const pb = at(b);
		const isPreview = aim.preview && i === aim.edges.length - 1;
		if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < 70 && !isPreview) return;
		labelBox(
			ctx,
			formatBlocks(stats.segments[i] as number),
			(pa.x + pb.x) / 2,
			(pa.y + pb.y) / 2,
			isPreview ? "#ffe866" : "#fff",
		);
	});

	// The total follows the end being drawn once there is more than one segment.
	if (stats.segments.length > 1) {
		const d = measureShape.state.value;
		const lastEdge = aim.edges.at(-1);
		const index =
			aim.preview && lastEdge
				? lastEdge[1]
				: (d?.selected ?? aim.points.length - 1);
		const end = at(index);
		const text =
			stats.area !== null
				? `Perimeter ${formatBlocks(stats.total)} · Area ${formatBlocks(stats.area)}`
				: `Total ${formatBlocks(stats.total)}`;
		labelBox(ctx, text, end.x, end.y - 26, "#ffe866");
	}
	ctx.restore();
}

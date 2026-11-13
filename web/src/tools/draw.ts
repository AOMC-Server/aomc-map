import { draftLook } from "../state";
import { createShapeEditor } from "./shape";

export {
	type DrawState,
	drawnGeometry,
	drawReady,
	minPoints,
	vertexAction,
} from "./shape";

/**
 * Geometry placement for the feature editor: the shape editor (see shape.ts) in the colours of
 * the feature being made.
 */
export const featureShape = createShapeEditor({
	smooth: () => draftLook.value?.smooth ?? false,
	mapDrawsShape: () => draftLook.value !== null,
	style: {
		line: "#ffe866",
		first: "#52a535",
		markFirst: false,
		fillLoops: false,
	},
});

export const drawing = featureShape.state;
export const focusedPoint = featureShape.focused;

export const startDraw = featureShape.start;
export const setDrawType = featureShape.setType;
export const setPoint = featureShape.setPoint;
export const removePoint = featureShape.removePoint;
export const undoPoint = featureShape.undoPoint;
export const selectPoint = featureShape.selectPoint;
export const resumeDraw = featureShape.resume;
export const finishDraw = featureShape.finish;
export const stopDraw = featureShape.stop;
export const stopDrawing = featureShape.stopDrawing;
export const grabDrawPoint = featureShape.grab;
export const drawCursor = featureShape.cursor;
export const removeDrawPointAt = featureShape.removeAt;
export const initDrawTool = featureShape.init;
export const drawGeometry = featureShape.draw;

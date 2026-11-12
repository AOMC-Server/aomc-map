import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Point } from "@aomc/shared/features";
import type { MapView } from "../map/MapView";
import { activeTool, editor, type LayerData, layersData } from "../state";
import { stopDraw } from "./draw";
import { graphFromPaths } from "./lineGraph";
import {
	endMeasure,
	featureFromMeasure,
	measureFrom,
	measureOf,
	measureShape,
	measureStats,
	measureSummary,
	startMeasure,
} from "./measure";

const square: Point[] = [
	[0, 0],
	[100, 0],
	[100, 100],
	[0, 100],
	[0, 0],
];
const path: Point[] = [
	[0, 0],
	[100, 0],
	[100, 100],
];
const fork: Point[][] = [
	[
		[0, 0],
		[100, 0],
		[200, 0],
	],
	[
		[100, 0],
		[100, 100],
	],
];

describe("measureOf", () => {
	test("a path has ends, with a distance and a direction between them", () => {
		const m = measureOf(graphFromPaths([path]));
		expect(m.total).toBe(200);
		expect(m.segments).toEqual([100, 100]);
		expect(m.closed).toBe(false);
		expect(m.ends?.dx).toBe(100);
		expect(m.ends?.dz).toBe(100);
		expect(m.ends?.straight).toBeCloseTo(141.42, 1);
	});

	test("a loop has a perimeter and an area, and no ends", () => {
		const m = measureOf(graphFromPaths([square]));
		expect(m.closed).toBe(true);
		expect(m.total).toBe(400);
		expect(m.area).toBe(10_000);
		expect(m.ends).toBeNull();
	});

	test("a fork adds up all its segments and has no ends", () => {
		const m = measureOf(graphFromPaths(fork));
		expect(m.total).toBe(300);
		expect(m.ends).toBeNull();
		expect(m.area).toBeNull();
	});

	test("the summary fits the shape", () => {
		expect(measureSummary(graphFromPaths([path]))[0]).toBe(
			"Distance: 200 blocks",
		);
		expect(measureSummary(graphFromPaths([square]))[1]).toBe(
			"Area: 10,000 blocks²",
		);
		expect(measureSummary(graphFromPaths(fork))[0]).toBe(
			"Total length: 300 blocks",
		);
	});
});

type Handler = (e: never) => void;
const handlers = new Map<string, Handler>();
const realWindow = (globalThis as { window?: unknown }).window;
const map = {
	on: (name: string, cb: Handler) => handlers.set(name, cb),
	invalidate() {},
	screenToBlock: (x: number, z: number) => ({ x, z }),
	blockToScreen: (x: number, z: number) => ({ x, y: z }),
} as unknown as MapView;
const emit = (name: string, e: unknown) =>
	(handlers.get(name) as Handler)(e as never);
const click = (sx: number, sy: number) => emit("click", { sx, sy });
/** A press on the point at block (x, z) that does not move: a click on it. */
const clickPoint = (x: number, z: number) =>
	(
		measureShape.grab(map, x + 0.5, z + 0.5) as NonNullable<
			ReturnType<typeof measureShape.grab>
		>
	).end();
const pointer = (sx: number, sy: number) => emit("move", { sx, sy });

function key(k: string) {
	const e = new Event("keydown", { cancelable: true });
	Object.defineProperty(e, "key", { value: k });
	Object.defineProperty(e, "target", { value: null });
	window.dispatchEvent(e);
}

beforeAll(() => {
	(globalThis as { window?: unknown }).window = new EventTarget();
	measureShape.init(map);
});
afterAll(() => {
	(globalThis as { window?: unknown }).window = realWindow;
});
beforeEach(() => {
	stopDraw();
	endMeasure();
	editor.value = null;
	layersData.value = [];
	activeTool.value = "measure";
	startMeasure();
});

describe("the measure tool", () => {
	test("measures a path, and the segment to the pointer while aiming", () => {
		click(0.5, 0.5);
		click(100.5, 0.5);
		expect(measureStats.value?.total).toBe(100);
		pointer(100.5, 100.5);
		expect(measureStats.value?.total).toBe(200);
		expect(measureStats.value?.preview).toBe(true);
	});

	test("clicking the first point closes the shape and gives its area", () => {
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		pointer(0.5, 0.5);
		expect(measureStats.value?.area).toBe(5_000);
		clickPoint(0, 0);
		expect(measureShape.state.value?.mode).toBe("placed");
		expect(measureStats.value?.closed).toBe(true);
		expect(measureStats.value?.preview).toBe(false);
	});

	test("a finished measurement can branch from a point in the middle", () => {
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(200.5, 0.5);
		key("Enter");
		expect(measureShape.state.value?.mode).toBe("placed");
		clickPoint(100, 0);
		click(100.5, 100.5);
		key("Enter");
		expect(measureStats.value?.total).toBe(300);
		expect(measureStats.value?.ends).toBeNull();
	});

	test("a point can be removed, joining its neighbours", () => {
		click(0.5, 0.5);
		click(100.5, 100.5);
		click(200.5, 0.5);
		key("Enter");
		expect(measureShape.removeAt(map, 100.5, 100.5)).toBe(true);
		expect(measureStats.value?.segments).toEqual([200]);
	});

	test("Esc stops, then clears, then closes the tool", () => {
		click(0.5, 0.5);
		click(100.5, 0.5);
		key("Escape");
		expect(measureShape.state.value?.mode).toBe("placed");
		key("Escape");
		expect(measureShape.state.value?.points).toEqual([]);
		expect(activeTool.value).toBe("measure");
		key("Escape");
		expect(activeTool.value).toBe("none");
	});

	test("measuring from a spot starts there", () => {
		measureFrom({ x: 7, z: 9 });
		expect(measureShape.state.value?.points).toEqual([[7, 9]]);
		expect(measureShape.state.value?.selected).toBe(0);
	});

	test("does nothing while another tool has the pointer", () => {
		activeTool.value = "none";
		click(0.5, 0.5);
		expect(measureShape.state.value?.points).toEqual([]);
	});
});

describe("turning a measurement into a feature", () => {
	const layer = {
		id: 4,
		canEdit: true,
		hiddenByDefault: false,
		features: [],
	} as unknown as LayerData;

	test("opens the editor on the line in a layer you can add to", () => {
		layersData.value = [layer];
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		expect(featureFromMeasure("line")).toBe(true);
		expect(activeTool.value).toBe("none");
		expect(editor.value).toEqual({
			mode: "create",
			layerId: 4,
			shape: { type: "line", paths: [path] },
		});
	});

	test("a branching measurement keeps its branches", () => {
		layersData.value = [layer];
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(200.5, 0.5);
		key("Enter");
		clickPoint(100, 0);
		click(100.5, 100.5);
		key("Enter");
		expect(featureFromMeasure("line")).toBe(true);
		const shape = (editor.value as { shape: { paths: Point[][] } }).shape;
		expect(shape.paths).toHaveLength(2);
	});

	test("an area needs a closed loop", () => {
		layersData.value = [layer];
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		expect(featureFromMeasure("polygon")).toBe(false);
		expect(editor.value).toBeNull();
		clickPoint(0, 0);
		expect(featureFromMeasure("polygon")).toBe(true);
		expect(
			(editor.value as { shape: { type: string; paths: Point[][] } }).shape,
		).toEqual({
			type: "polygon",
			paths: [
				[
					[0, 0],
					[100, 0],
					[100, 100],
				],
			],
		});
	});

	test("needs a layer, and something measured", () => {
		click(0.5, 0.5);
		click(100.5, 0.5);
		expect(featureFromMeasure("line")).toBe(false);
		layersData.value = [layer];
		endMeasure();
		startMeasure();
		click(0.5, 0.5);
		expect(featureFromMeasure("line")).toBe(false);
		expect(activeTool.value).toBe("measure");
	});
});

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Pt } from "../map/geometry";
import type { MapView } from "../map/MapView";
import { segmentKey, segmentMids, smoothShape } from "../map/smooth";
import { draftLook } from "../state";
import {
	drawCursor,
	drawing,
	drawnGeometry,
	featureShape,
	finishDraw,
	grabDrawPoint,
	initDrawTool,
	removeDrawPointAt,
	resumeDraw,
	startDraw,
	stopDraw,
} from "./draw";
import { draftOf } from "./shape";

type Handler = (e: never) => void;
const handlers = new Map<string, Handler>();
let invalidations = 0;
const realWindow = (globalThis as { window?: unknown }).window;

const map = {
	on: (name: string, cb: Handler) => handlers.set(name, cb),
	invalidate: () => invalidations++,
	screenToBlock: (x: number, z: number) => ({ x, z }),
	blockToScreen: (x: number, z: number) => ({ x, y: z }),
} as unknown as MapView;

const emit = (name: string, e: unknown) =>
	(handlers.get(name) as Handler)(e as never);
const click = (sx: number, sy: number) => emit("click", { sx, sy });
const pointsOf = () => drawing.value?.points;

beforeAll(() => {
	(globalThis as { window?: unknown }).window = new EventTarget();
	initDrawTool(map);
});
afterAll(() => {
	(globalThis as { window?: unknown }).window = realWindow;
});
/** Back to placing vertices, as the editor's "continue" does. */
const resume = () => resumeDraw();

beforeEach(() => {
	stopDraw();
	invalidations = 0;
});

function key(k: string, target: unknown = null) {
	const e = new Event("keydown", { cancelable: true });
	Object.defineProperty(e, "key", { value: k });
	Object.defineProperty(e, "target", { value: target });
	window.dispatchEvent(e);
	return e;
}

const element = (matches: string[], tagName = "DIV") => ({
	tagName,
	isContentEditable: false,
	closest: (sel: string) =>
		sel.split(", ").some((s) => matches.includes(s)) ? {} : null,
});

describe("placing vertices", () => {
	test("a click in the block of the last vertex adds nothing", () => {
		startDraw("line", [], () => {});
		click(10.2, 20.2);
		click(10.8, 20.9);
		expect(pointsOf()).toEqual([[10, 20]]);
		click(11.1, 20.5);
		expect(pointsOf()).toEqual([
			[10, 20],
			[11, 20],
		]);
	});

	test("an area needs three different blocks, a line one segment", () => {
		drawing.value = {
			type: "polygon",
			points: [
				[0, 0],
				[0, 0],
				[5, 5],
			],
			edges: [],
			selected: null,
			mode: "draw",
		};
		expect(finishDraw()).toBe(false);
		drawing.value = {
			type: "line",
			points: [[3, 3]],
			edges: [],
			selected: 0,
			mode: "draw",
		};
		expect(finishDraw()).toBe(false);
		drawing.value = {
			type: "line",
			points: [
				[3, 3],
				[4, 3],
			],
			edges: [[0, 1]],
			selected: null,
			mode: "draw",
		};
		expect(finishDraw()).toBe(true);
		expect(drawing.value?.mode).toBe("placed");
	});

	test("moving within one block does not repaint the map", () => {
		startDraw("line", [], () => {});
		emit("move", { sx: 5.1, sy: 5.1 });
		const n = invalidations;
		emit("move", { sx: 5.7, sy: 5.3 });
		expect(invalidations).toBe(n);
		emit("move", { sx: 6.1, sy: 5.3 });
		expect(invalidations).toBe(n + 1);
	});
});

describe("Enter, Escape and Backspace", () => {
	test("Enter finishes a shape being drawn", () => {
		startDraw(
			"line",
			[
				[
					[0, 0],
					[9, 9],
				],
			],
			() => {},
		);
		resume();
		expect(key("Enter", element([])).defaultPrevented).toBe(true);
		expect(drawing.value?.mode).toBe("placed");
	});

	test("Enter is left alone once the shape is placed", () => {
		startDraw(
			"line",
			[
				[
					[0, 0],
					[9, 9],
				],
			],
			() => {},
		);
		expect(drawing.value?.mode).toBe("placed");
		expect(key("Enter", element([])).defaultPrevented).toBe(false);
	});

	test("Enter on a focused button or inside a panel is left alone", () => {
		startDraw(
			"line",
			[
				[
					[0, 0],
					[9, 9],
				],
			],
			() => {},
		);
		resume();
		expect(key("Enter", element(["button"], "BUTTON")).defaultPrevented).toBe(
			false,
		);
		expect(key("Enter", element([".panel"])).defaultPrevented).toBe(false);
		expect(drawing.value?.mode).toBe("draw");
	});

	test("Backspace undoes a vertex, but not while typing or inside a panel", () => {
		startDraw(
			"line",
			[
				[
					[0, 0],
					[9, 9],
					[20, 20],
				],
			],
			() => {},
		);
		key("Backspace", element([], "INPUT"));
		key("Backspace", element([".panel"]));
		expect(pointsOf()).toHaveLength(3);
		expect(key("Backspace", element([])).defaultPrevented).toBe(true);
		expect(pointsOf()).toHaveLength(2);
	});

	test("Escape stops drawing segments and keeps the line", () => {
		let cancelled = false;
		startDraw("line", [], () => {
			cancelled = true;
		});
		click(0.5, 0.5);
		click(100.5, 0.5);
		key("Escape", element([".modal"]));
		expect(drawing.value?.mode).toBe("draw");
		key("Escape", element([]));
		expect(cancelled).toBe(false);
		expect(drawing.value?.mode).toBe("placed");
		expect(drawing.value?.points).toHaveLength(2);
		// Again: nothing more to stop, and the line stays.
		key("Escape", element([]));
		expect(cancelled).toBe(false);
		expect(drawing.value?.points).toHaveLength(2);
	});

	test("Escape on a line too short to keep stops drawing from its point", () => {
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		key("Escape", element([]));
		expect(drawing.value?.selected).toBeNull();
		expect(drawing.value?.points).toHaveLength(1);
	});

	test("Escape with nothing drawn closes the editor", () => {
		let cancelled = false;
		startDraw("line", [], () => {
			cancelled = true;
		});
		key("Escape", element([]));
		expect(cancelled).toBe(true);
		expect(drawing.value).toBeNull();
	});
});

describe("the + handle of a segment", () => {
	const square: [number, number][] = [
		[0, 0],
		[100, 0],
		[100, 100],
	];

	test("an area has no closing segment to pull from while it is being drawn", () => {
		startDraw("polygon", [square], () => {});
		resume();
		// Midpoint of the closing segment (100, 100) -> (0, 0).
		expect(grabDrawPoint(map, 50.5, 50.5)).toBeNull();
		// The drawn segments still have theirs.
		expect(grabDrawPoint(map, 50.5, 0.5)).not.toBeNull();
	});

	test("a placed area has one", () => {
		startDraw("polygon", [square], () => {});
		expect(drawing.value?.mode).toBe("placed");
		expect(grabDrawPoint(map, 50.5, 50.5)).not.toBeNull();
		expect(pointsOf()).toHaveLength(4);
	});
});

describe("pressing on the last vertex of a line", () => {
	const press = () => {
		startDraw(
			"line",
			[
				[
					[0, 0],
					[200, 0],
				],
			],
			() => {},
		);
		resume();
		return grabDrawPoint(map, 200.5, 0.5) as NonNullable<
			ReturnType<typeof grabDrawPoint>
		>;
	};

	test("finishes the line when released as a click", () => {
		press().end();
		expect(drawing.value?.mode).toBe("placed");
	});

	test("does not when the gesture was cancelled, e.g. by a second finger", () => {
		press().cancel();
		expect(drawing.value?.mode).toBe("draw");
	});
});

describe("branches and loops", () => {
	const road: [number, number][] = [
		[0, 0],
		[100, 0],
		[200, 0],
	];
	/** A press on the vertex at block (x, z) that does not move: a click on it. */
	const clickVertex = (x: number, z: number) =>
		(
			grabDrawPoint(map, x + 0.5, z + 0.5) as NonNullable<
				ReturnType<typeof grabDrawPoint>
			>
		).end();
	const geometry = () =>
		drawnGeometry(drawing.value as NonNullable<typeof drawing.value>);

	test("clicking a vertex in the middle of a line branches from it", () => {
		startDraw("line", [road], () => {});
		clickVertex(100, 0);
		expect(drawing.value?.mode).toBe("draw");
		expect(drawing.value?.selected).toBe(1);
		click(100.5, 100.5);
		expect(key("Enter", element([])).defaultPrevented).toBe(true);
		expect(geometry()).toEqual([
			[
				[0, 0],
				[100, 0],
				[200, 0],
			],
			[
				[100, 0],
				[100, 100],
			],
		]);
	});

	test("clicking another vertex while drawing joins it and finishes", () => {
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		clickVertex(0, 0);
		expect(drawing.value?.mode).toBe("placed");
		expect(geometry()).toEqual([
			[0, 0],
			[100, 0],
			[100, 100],
			[0, 0],
		]);
	});

	test("a click in the block of a vertex joins it too", () => {
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		click(0.9, 0.1);
		expect(drawing.value?.points).toHaveLength(3);
		expect(drawing.value?.edges).toHaveLength(3);
	});

	test("an end dragged onto another vertex merges with it", () => {
		startDraw("line", [[...road, [200, 100]]], () => {});
		const drag = grabDrawPoint(map, 200.5, 100.5) as NonNullable<
			ReturnType<typeof grabDrawPoint>
		>;
		drag.move(50, 50);
		drag.move(0.5, 0.5);
		drag.end();
		expect(drawing.value?.points).toHaveLength(3);
		expect(geometry()).toEqual([
			[0, 0],
			[100, 0],
			[200, 0],
			[0, 0],
		]);
	});

	test("the + of a line's segment splits it", () => {
		startDraw("line", [road], () => {});
		const drag = grabDrawPoint(map, 50.5, 0.5);
		expect(drag).not.toBeNull();
		drag?.move(50.5, 40.5);
		drag?.end();
		expect(geometry()).toEqual([
			[0, 0],
			[50, 40],
			[100, 0],
			[200, 0],
		]);
	});
});

describe("removing vertices", () => {
	const road: [number, number][] = [
		[0, 0],
		[100, 0],
		[200, 0],
	];

	test("a right click on a vertex removes it and joins its neighbours", () => {
		startDraw("line", [road], () => {});
		expect(removeDrawPointAt(map, 300, 300)).toBe(false);
		expect(removeDrawPointAt(map, 100.5, 0.5)).toBe(true);
		expect(pointsOf()).toEqual([
			[0, 0],
			[200, 0],
		]);
		expect(drawing.value?.edges).toEqual([[0, 1]]);
		expect(drawing.value?.mode).toBe("placed");
	});

	test("Delete removes the selected vertex of an area", () => {
		startDraw("polygon", [[...road, [100, 100], [0, 100]]], () => {});
		(
			grabDrawPoint(map, 100.5, 0.5) as NonNullable<
				ReturnType<typeof grabDrawPoint>
			>
		).end();
		expect(drawing.value?.selected).toBe(1);
		key("Delete", element([]));
		expect(pointsOf()).toHaveLength(4);
		expect(drawing.value?.selected).toBeNull();
		expect(drawing.value?.mode).toBe("placed");
	});

	test("Backspace while drawing a line goes back to the vertex before", () => {
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(200.5, 0.5);
		key("Backspace", element([]));
		expect(drawing.value?.selected).toBe(1);
		click(100.5, 100.5);
		expect(drawing.value?.edges).toEqual([
			[0, 1],
			[1, 2],
		]);
	});
});

describe("the cursor", () => {
	const road: [number, number][] = [
		[0, 0],
		[100, 0],
		[100, 100],
	];

	test("shows what a click or drag would do on a line being drawn", () => {
		startDraw("line", [road], () => {});
		expect(drawCursor(map, 300, 300)).toBe("crosshair");
		expect(drawCursor(map, 100.5, 0.5)).toBe("grab");
		expect(drawCursor(map, 50.5, 0.5)).toBe("copy");
		resume();
		expect(drawing.value?.selected).toBe(2);
		expect(drawCursor(map, 300, 300)).toBe("crosshair");
		expect(drawCursor(map, 100.5, 100.5)).toBe("pointer");
		expect(drawCursor(map, 100.5, 0.5)).toBe("pointer");
		expect(drawCursor(map, 0.5, 0.5)).toBe("alias");
	});

	test("the first point of an area closes it", () => {
		startDraw("polygon", [road], () => {});
		resume();
		expect(drawCursor(map, 0.5, 0.5)).toBe("pointer");
		expect(drawCursor(map, 100.5, 0.5)).toBe("grab");
	});

	test("nothing is chosen while not drawing", () => {
		expect(drawCursor(map, 0, 0)).toBeNull();
	});
});

describe("the smooth preview while drawing", () => {
	const look = (smooth: boolean) => {
		draftLook.value = { color: null, style: null, smooth };
	};
	const move = (sx: number, sy: number) => emit("move", { sx, sy });
	afterAll(() => {
		draftLook.value = null;
	});

	test("a line is drawn through the pointer, which bends the curve before it", () => {
		look(true);
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		move(200.5, 100.5);
		const curve = featureShape.curve.value;
		// The pointer is part of what the map draws, the segment to it being the one that is dashed.
		expect(curve?.draft).toEqual({
			type: "line",
			geometry: [
				[0, 0],
				[100, 0],
				[100, 100],
				[200, 100],
			],
		});
		expect(featureShape.draft.value).toEqual(curve?.draft ?? null);
		expect(curve?.edge).toEqual([
			[100, 100],
			[200, 100],
		]);
		const stroke = curve?.shape.strokes[0];
		expect(stroke?.samples.at(-1)).toEqual([200, 100]);
		expect(stroke?.beziers.map((b) => b[2])).toEqual([
			[100, 0],
			[100, 100],
			[200, 100],
		]);
		// The shape itself has not changed.
		expect(drawing.value?.points).toHaveLength(3);
	});

	test("moving the pointer bends the curve before it", () => {
		look(true);
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		move(200.5, 100.5);
		const before = featureShape.curve.value?.shape.strokes[0]?.beziers[1];
		move(100.5, 300.5);
		const after = featureShape.curve.value?.shape.strokes[0]?.beziers[1];
		expect(after).not.toEqual(before);
	});

	test("the dashed piece is one of the pieces of the curve", () => {
		look(true);
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		move(200.5, 100.5);
		const curve = featureShape.curve.value as NonNullable<
			typeof featureShape.curve.value
		>;
		const [a, b] = curve.edge as [Pt, Pt];
		expect(segmentMids(curve.shape).has(segmentKey(a, b))).toBe(true);
	});

	test("nothing curved when smoothing is off", () => {
		look(false);
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		move(200.5, 100.5);
		expect(featureShape.curve.value).toBeNull();
		// The map draws what is placed.
		expect(featureShape.draft.value?.geometry).toEqual([
			[0, 0],
			[100, 0],
		]);
	});

	test("over a point of the line the preview is the loop it would close", () => {
		look(true);
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		move(0.5, 0.5);
		const curve = featureShape.curve.value;
		expect(curve?.edge).toEqual([
			[100, 100],
			[0, 0],
		]);
		expect(curve?.shape.strokes).toHaveLength(1);
		expect(curve?.shape.strokes[0]?.closed).toBe(true);
	});

	test("an area being drawn is a closed curve through the pointer too", () => {
		look(true);
		startDraw("polygon", [], () => {});
		click(0.5, 0.5);
		click(100.5, 0.5);
		click(100.5, 100.5);
		move(0.5, 100.5);
		const curve = featureShape.curve.value;
		expect(curve?.draft.type).toBe("polygon");
		expect(curve?.draft.geometry).toEqual([
			[0, 0],
			[100, 0],
			[100, 100],
			[0, 100],
		]);
		expect(curve?.edge).toEqual([
			[100, 100],
			[0, 100],
		]);
		expect(curve?.shape.strokes[0]?.closed).toBe(true);
		// Once placed it is the closed curve through its own points.
		finishDraw();
		expect(featureShape.curve.value?.draft.geometry).toEqual([
			[0, 0],
			[100, 0],
			[100, 100],
		]);
		expect(featureShape.curve.value?.edge).toBeNull();
	});

	test("an area with a single point and the pointer on it has no curve yet", () => {
		look(true);
		startDraw("polygon", [], () => {});
		click(0.5, 0.5);
		move(0.5, 0.5);
		expect(featureShape.curve.value).toBeNull();
	});
});

describe("what the map draws for the shape being edited", () => {
	const draft = () =>
		draftOf(drawing.value as NonNullable<typeof drawing.value>);

	test("a line shows once it has a segment, an area once it has three points", () => {
		startDraw("line", [], () => {});
		click(0.5, 0.5);
		expect(draft()).toBeNull();
		click(100.5, 0.5);
		expect(draft()).toEqual({
			type: "line",
			geometry: [
				[0, 0],
				[100, 0],
			],
		});

		startDraw("polygon", [], () => {});
		click(0.5, 0.5);
		expect(draft()).toBeNull();
		// Two points of an area are shown as the line between them.
		click(100.5, 0.5);
		expect(draft()?.type).toBe("line");
		click(100.5, 100.5);
		expect(draft()).toEqual({
			type: "polygon",
			geometry: [
				[0, 0],
				[100, 0],
				[100, 100],
			],
		});
	});

	test("a pin is not drawn by the map", () => {
		startDraw("pin", [[[5, 5]]], () => {});
		expect(draft()).toBeNull();
	});

	test("a branching line keeps its branches", () => {
		startDraw(
			"line",
			[
				[
					[0, 0],
					[100, 0],
					[200, 0],
				],
				[
					[100, 0],
					[100, 100],
				],
			],
			() => {},
		);
		expect(draft()?.geometry).toHaveLength(2);
	});
});

describe("the + handle of a smooth line", () => {
	const bend: [number, number][] = [
		[0, 0],
		[300, 0],
		[300, 300],
		[600, 300],
	];
	// The middle of the curve of the first segment, and of its straight line.
	const onCurve = [168.75, -18.75] as const;
	const straightMid = [150, 0] as const;

	test("sits on the curve instead of the middle of the segment", () => {
		draftLook.value = { color: null, style: null, smooth: true };
		startDraw("line", [bend], () => {});
		expect(drawCursor(map, onCurve[0] + 0.5, onCurve[1] + 0.5)).toBe("copy");
		expect(drawCursor(map, straightMid[0] + 0.5, straightMid[1] + 0.5)).toBe(
			"crosshair",
		);
	});

	test("pulls out a new point from where it is on the curve", () => {
		draftLook.value = { color: null, style: null, smooth: true };
		startDraw("line", [bend], () => {});
		const drag = grabDrawPoint(map, onCurve[0] + 0.5, onCurve[1] + 0.5);
		expect(drag).not.toBeNull();
		drag?.end();
		expect(drawing.value?.points.at(-1)).toEqual([169, -19]);
		expect(drawing.value?.edges).toHaveLength(4);
	});

	test("stays in the middle of the segment when the line is not smooth", () => {
		draftLook.value = { color: null, style: null, smooth: false };
		startDraw("line", [bend], () => {});
		expect(drawCursor(map, straightMid[0] + 0.5, straightMid[1] + 0.5)).toBe(
			"copy",
		);
		expect(drawCursor(map, onCurve[0] + 0.5, onCurve[1] + 0.5)).toBe(
			"crosshair",
		);
	});

	test("is on the curve of an area too", () => {
		draftLook.value = { color: null, style: null, smooth: true };
		startDraw(
			"polygon",
			[
				[
					[0, 0],
					[300, 0],
					[300, 300],
					[0, 300],
				],
			],
			() => {},
		);
		const ring = smoothShape("polygon", [
			[
				[0, 0],
				[300, 0],
				[300, 300],
				[0, 300],
			],
		]);
		const [mid] = [...segmentMids(ring).values()] as [Pt];
		expect(drawCursor(map, mid[0] + 0.5, mid[1] + 0.5)).toBe("copy");
	});
});

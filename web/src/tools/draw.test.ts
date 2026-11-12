import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { MapView } from "../map/MapView";
import {
	drawCursor,
	drawing,
	drawnGeometry,
	finishDraw,
	grabDrawPoint,
	initDrawTool,
	removeDrawPointAt,
	resumeDraw,
	startDraw,
	stopDraw,
} from "./draw";

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

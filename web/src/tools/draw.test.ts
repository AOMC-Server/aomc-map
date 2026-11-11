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
	drawing,
	finishDraw,
	grabDrawPoint,
	initDrawTool,
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

	test("an area needs three different blocks, a line two", () => {
		drawing.value = {
			type: "polygon",
			points: [
				[0, 0],
				[0, 0],
				[5, 5],
			],
			mode: "draw",
		};
		expect(finishDraw()).toBe(false);
		drawing.value = {
			type: "line",
			points: [
				[3, 3],
				[3, 3],
			],
			mode: "draw",
		};
		expect(finishDraw()).toBe(false);
		drawing.value = {
			type: "line",
			points: [
				[3, 3],
				[4, 3],
			],
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
				[0, 0],
				[9, 9],
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
				[0, 0],
				[9, 9],
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
				[0, 0],
				[9, 9],
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
				[0, 0],
				[9, 9],
				[20, 20],
			],
			() => {},
		);
		key("Backspace", element([], "INPUT"));
		key("Backspace", element([".panel"]));
		expect(pointsOf()).toHaveLength(3);
		expect(key("Backspace", element([])).defaultPrevented).toBe(true);
		expect(pointsOf()).toHaveLength(2);
	});

	test("Escape cancels the drawing", () => {
		let cancelled = false;
		startDraw("line", [[0, 0]], () => {
			cancelled = true;
		});
		key("Escape", element([".modal"]));
		expect(cancelled).toBe(false);
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
		startDraw("polygon", square, () => {});
		resume();
		// Midpoint of the closing segment (100, 100) -> (0, 0).
		expect(grabDrawPoint(map, 50.5, 50.5)).toBeNull();
		// The drawn segments still have theirs.
		expect(grabDrawPoint(map, 50.5, 0.5)).not.toBeNull();
	});

	test("a placed area has one", () => {
		startDraw("polygon", square, () => {});
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
				[0, 0],
				[200, 0],
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

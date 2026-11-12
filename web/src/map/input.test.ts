import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { View } from "@aomc/shared/view";
import {
	type DragSession,
	Input,
	isInteractiveTarget,
	isUiKeyTarget,
} from "./input";
import type { MapView } from "./MapView";

class FakeElement extends EventTarget {
	getBoundingClientRect() {
		return { left: 0, top: 0 };
	}
	setPointerCapture() {}
}

type Call = [string, ...unknown[]];

let el: FakeElement;
let calls: Call[];
let views: View[];
let session: DragSession | null;
let sessionCalls: string[];
let time: number;
const realWindow = (globalThis as { window?: unknown }).window;

beforeAll(() => {
	(globalThis as { window?: unknown }).window = new EventTarget();
});
afterAll(() => {
	(globalThis as { window?: unknown }).window = realWindow;
});

beforeEach(() => {
	el = new FakeElement();
	calls = [];
	views = [];
	session = null;
	sessionCalls = [];
	time = 1000;
	const map = {
		dragHandler: () => session,
		cancelAnimation() {},
		pointer: (...a: unknown[]) => calls.push(["pointer", ...a]),
		pointerLeft() {},
		setGrabbing() {},
		contextMenu: (...a: unknown[]) => calls.push(["contextMenu", ...a]),
		getView: (): View => views.at(-1) ?? { centerX: 0, centerZ: 0, zoom: 0 },
		setView: (v: View) => views.push(v),
		clampZoom: (z: number) => z,
		getSize: () => ({ width: 200, height: 200 }),
		zoomBy: (...a: unknown[]) => calls.push(["zoomBy", ...a]),
		inertia: (...a: unknown[]) => calls.push(["inertia", ...a]),
		zoomInertia: (...a: unknown[]) => calls.push(["zoomInertia", ...a]),
		tweenTo() {},
		doubleClickZoom: true,
	};
	new Input(el as unknown as HTMLElement, map as unknown as MapView);
});

function fire(type: string, props: Record<string, unknown>) {
	const e = new Event(type, { cancelable: true });
	for (const [k, v] of Object.entries(props))
		Object.defineProperty(e, k, { value: v });
	el.dispatchEvent(e);
	return e;
}

const pointer = (
	type: "down" | "move" | "up" | "cancel",
	id: number,
	x: number,
	y: number,
) => {
	time += 10;
	return fire(`pointer${type}`, {
		pointerId: id,
		pointerType: "touch",
		button: 0,
		clientX: x,
		clientY: y,
		timeStamp: time,
	});
};

const spy = (): DragSession => ({
	move: () => sessionCalls.push("move"),
	end: () => sessionCalls.push("end"),
	cancel: () => sessionCalls.push("cancel"),
});

describe("wheel", () => {
	const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) =>
		fire("wheel", { deltaY, deltaMode, ctrlKey, clientX: 5, clientY: 6 });

	test("a line-mode notch (Firefox) snaps to the zoom grid", () => {
		const e = wheel(3, 1);
		expect(e.defaultPrevented).toBe(true);
		expect(calls).toEqual([["zoomBy", 0.24, { x: 5, y: 6 }, 80, 0.5]]);
	});

	test("a smooth trackpad step does not snap", () => {
		wheel(4);
		expect(calls).toEqual([["zoomBy", 0.02, { x: 5, y: 6 }, 30, undefined]]);
	});

	test("a sideways tilt of the wheel does not zoom", () => {
		const e = wheel(0, 1);
		expect(e.defaultPrevented).toBe(true);
		expect(calls).toEqual([]);
	});
});

describe("pinch", () => {
	test("lifting one finger of a pinch carries on as a drag with the other", () => {
		pointer("down", 1, 50, 100);
		pointer("down", 2, 150, 100);
		pointer("up", 2, 150, 100);
		expect(views).toEqual([]);
		pointer("move", 1, 60, 100);
		expect(views).toHaveLength(1);
		expect((views[0] as View).centerX).toBeCloseTo(-10);
		pointer("up", 1, 60, 100);
		// It was a gesture, not a click.
		expect(calls.filter((c) => c[0] === "pointer")).toEqual([]);
	});

	test("lifting one of three fingers re-bases the pinch on the two left", () => {
		pointer("down", 1, 0, 0);
		pointer("down", 2, 100, 0);
		pointer("down", 3, 50, 100);
		pointer("up", 1, 0, 0);
		views.length = 0;
		pointer("move", 2, 101, 0);
		expect(views).toHaveLength(1);
		const v = views[0] as View;
		// Without re-basing, the midpoint would jump from (50, 0) to (75, 50).
		expect(Math.abs(v.centerX)).toBeLessThan(2);
		expect(Math.abs(v.centerZ)).toBeLessThan(2);
		expect(Math.abs(v.zoom)).toBeLessThan(0.1);
	});
});

describe("drag sessions", () => {
	test("lifting the pointer ends the session", () => {
		session = spy();
		pointer("down", 1, 10, 10);
		pointer("move", 1, 20, 20);
		pointer("up", 1, 20, 20);
		expect(sessionCalls).toEqual(["move", "end"]);
	});

	test("a second finger cancels the session instead of ending it", () => {
		session = spy();
		pointer("down", 1, 10, 10);
		pointer("down", 2, 100, 100);
		expect(sessionCalls).toEqual(["cancel"]);
		pointer("up", 2, 100, 100);
		pointer("up", 1, 10, 10);
		expect(sessionCalls).toEqual(["cancel"]);
	});

	test("a cancelled pointer cancels the session", () => {
		session = spy();
		pointer("down", 1, 10, 10);
		pointer("cancel", 1, 10, 10);
		expect(sessionCalls).toEqual(["cancel"]);
	});
});

describe("context menu", () => {
	const menu = (x: number, y: number) =>
		fire("contextmenu", { clientX: x, clientY: y });

	test("a right click opens the menu where it was", () => {
		const e = menu(30, 40);
		expect(e.defaultPrevented).toBe(true);
		expect(calls).toEqual([["contextMenu", 30, 40]]);
	});

	test("a right click after a drag still opens the menu", () => {
		pointer("down", 1, 10, 10);
		pointer("move", 1, 40, 40);
		pointer("up", 1, 40, 40);
		calls.length = 0;
		menu(30, 40);
		expect(calls).toEqual([["contextMenu", 30, 40]]);
	});

	test("the long press that opened it is not also a click", () => {
		pointer("down", 1, 10, 10);
		menu(10, 10);
		pointer("up", 1, 10, 10);
		expect(calls).toEqual([["contextMenu", 10, 10]]);
	});

	test("not while dragging the map or a point", () => {
		pointer("down", 1, 10, 10);
		pointer("move", 1, 40, 40);
		menu(40, 40);
		pointer("up", 1, 40, 40);
		session = spy();
		pointer("down", 2, 10, 10);
		menu(10, 10);
		expect(calls.filter((c) => c[0] === "contextMenu")).toEqual([]);
	});
});

describe("key targets", () => {
	const target = (matches: string, tagName = "DIV") =>
		({
			tagName,
			isContentEditable: false,
			closest: (sel: string) =>
				sel.split(", ").some((s) => matches.split(" ").includes(s)) ? {} : null,
		}) as unknown as EventTarget;

	test("text fields and panels belong to the UI", () => {
		expect(isUiKeyTarget(target(""))).toBe(false);
		expect(isUiKeyTarget(target("", "INPUT"))).toBe(true);
		expect(isUiKeyTarget(target(".panel"))).toBe(true);
		expect(isUiKeyTarget(target(".modal"))).toBe(true);
		expect(isUiKeyTarget(null)).toBe(false);
	});

	test("buttons and links are interactive", () => {
		expect(isInteractiveTarget(target(""))).toBe(false);
		expect(isInteractiveTarget(target("button"))).toBe(true);
		expect(isInteractiveTarget(null)).toBe(false);
	});
});

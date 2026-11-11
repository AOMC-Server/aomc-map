import { describe, expect, test } from "bun:test";
import { dropIndex, moveItem } from "./reorder";

describe("moveItem", () => {
	test("moves an item without touching the original", () => {
		const a = ["a", "b", "c", "d"];
		expect(moveItem(a, 0, 2)).toEqual(["b", "c", "a", "d"]);
		expect(moveItem(a, 3, 0)).toEqual(["d", "a", "b", "c"]);
		expect(moveItem(a, 1, 1)).toEqual(a);
		expect(a).toEqual(["a", "b", "c", "d"]);
	});

	test("clamps the target and ignores a missing item", () => {
		expect(moveItem(["a", "b"], 0, 9)).toEqual(["b", "a"]);
		expect(moveItem(["a", "b"], 1, -3)).toEqual(["b", "a"]);
		expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
	});
});

describe("dropIndex", () => {
	// Four items, each 40 tall, with a 10 gap: middles at 20, 70, 120, 170.
	const mids = [20, 70, 120, 170];

	test("an item stays put until it passes the middle of its neighbour", () => {
		expect(dropIndex(mids, 1, 70)).toBe(1);
		expect(dropIndex(mids, 1, 100)).toBe(1);
		expect(dropIndex(mids, 1, 121)).toBe(2);
		expect(dropIndex(mids, 1, 19)).toBe(0);
	});

	test("goes to the ends", () => {
		expect(dropIndex(mids, 0, 1000)).toBe(3);
		expect(dropIndex(mids, 3, -1000)).toBe(0);
	});
});

import { describe, expect, test } from "bun:test";
import { dropIndex, insertIndex, moveItem, renumber } from "./reorder";

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

describe("renumber", () => {
	const dims = (...orders: number[]) =>
		orders.map((sortOrder, i) => ({ slug: `d${i}`, sortOrder }));

	test("numbers every item by its new position, changed ones only", () => {
		const out = renumber(dims(0, 1, 2), 0, 1);
		expect(out.map((c) => [c.item.slug, c.sortOrder])).toEqual([
			["d1", 0],
			["d0", 1],
		]);
	});

	test("repairs ties and gaps that a plain swap would keep", () => {
		const out = renumber(dims(0, 0, 5), 2, 1);
		expect(out.map((c) => [c.item.slug, c.sortOrder])).toEqual([
			["d2", 1],
			["d1", 2],
		]);
	});
});

describe("insertIndex", () => {
	test("counts the items above the drop point", () => {
		expect(insertIndex([10, 30, 50], 5)).toBe(0);
		expect(insertIndex([10, 30, 50], 40)).toBe(2);
		expect(insertIndex([10, 30, 50], 99)).toBe(3);
		expect(insertIndex([], 20)).toBe(0);
	});
});

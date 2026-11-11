import { describe, expect, test } from "bun:test";
import { assignOrder, sameSet } from "../src/order";

describe("assignOrder", () => {
	test("hands the existing positions out in the new order", () => {
		const current = [
			{ id: 1, sortOrder: 0 },
			{ id: 2, sortOrder: 1 },
			{ id: 3, sortOrder: 2 },
		];
		expect(assignOrder(current, [3, 1, 2])).toEqual([
			{ id: 3, sortOrder: 0 },
			{ id: 1, sortOrder: 1 },
			{ id: 2, sortOrder: 2 },
		]);
	});

	test("items that are left out keep their place between the others", () => {
		// 2 is hidden from this user and sits between 1 and 3.
		const visible = [
			{ id: 1, sortOrder: 0 },
			{ id: 3, sortOrder: 5 },
		];
		expect(assignOrder(visible, [3, 1])).toEqual([
			{ id: 3, sortOrder: 0 },
			{ id: 1, sortOrder: 5 },
		]);
	});

	test("equal positions are pulled apart so the order takes effect", () => {
		const tied = [
			{ id: 1, sortOrder: 0 },
			{ id: 2, sortOrder: 0 },
		];
		const out = assignOrder(tied, [2, 1]);
		expect(out[0]?.sortOrder).toBeLessThan(out[1]?.sortOrder as number);
	});
});

describe("sameSet", () => {
	test("needs exactly the same ids, once each", () => {
		const cur = [{ id: 1 }, { id: 2 }];
		expect(sameSet(cur, [2, 1])).toBe(true);
		expect(sameSet(cur, [1])).toBe(false);
		expect(sameSet(cur, [1, 1])).toBe(false);
		expect(sameSet(cur, [1, 3])).toBe(false);
		expect(sameSet([], [])).toBe(true);
	});
});

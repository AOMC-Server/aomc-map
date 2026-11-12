import { describe, expect, test } from "bun:test";
import { mapLimit } from "../src/concurrency";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("mapLimit", () => {
	test("keeps input order and never runs more than the limit at once", async () => {
		let running = 0;
		let most = 0;
		const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n, i) => {
			running++;
			most = Math.max(most, running);
			for (let k = 0; k < n; k++) await tick();
			running--;
			return n * 10 + i;
		});
		expect(out).toEqual([50, 11, 42, 23, 34, 5]);
		expect(most).toBe(2);
	});

	test("an empty list gives an empty result", async () => {
		expect(await mapLimit([], 4, async () => 1)).toEqual([]);
	});

	test("after an error starts nothing new, and throws once the running calls are done", async () => {
		const started: number[] = [];
		const finished: number[] = [];
		const run = mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
			started.push(n);
			await tick();
			if (n === 1) throw new Error("boom");
			await tick();
			finished.push(n);
			return n;
		});
		await expect(run).rejects.toThrow("boom");
		expect(started).toEqual([0, 1]);
		expect(finished).toEqual([0]);
	});
});

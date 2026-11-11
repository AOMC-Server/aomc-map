import { describe, expect, test } from "bun:test";
import { mergeRevisions, pageHasGap } from "./revisionLog";
import type { RevisionInfo } from "./state";

const r = (id: number, status = "done") => ({ id, status }) as RevisionInfo;
const ids = (list: RevisionInfo[]) => list.map((x) => x.id);

describe("mergeRevisions", () => {
	test("adds new revisions on top and updates changed ones", () => {
		const known = [r(2, "processing"), r(1)];
		const page = [r(3), r(2)];
		const merged = mergeRevisions(known, page, 2, [2]);
		expect(ids(merged)).toEqual([3, 2, 1]);
		expect(merged[1]?.status).toBe("done");
	});

	test("drops what the page covers but does not hold (deleted)", () => {
		const known = [r(4), r(3), r(2), r(1)];
		// The page holds 4 and 2 down to id 2; 3 is gone, 1 is older than the page.
		expect(ids(mergeRevisions(known, [r(4), r(2)], 2, []))).toEqual([4, 2, 1]);
	});

	test("keeps revisions still being processed", () => {
		const known = [r(5), r(1, "processing")];
		const merged = mergeRevisions(known, [r(5), r(1, "done")], 5, [1]);
		expect(merged.find((x) => x.id === 1)?.status).toBe("done");
	});
});

describe("pageHasGap", () => {
	test("a full page that does not reach what is loaded leaves a gap", () => {
		expect(pageHasGap([r(10), r(9)], 500)).toBe(true);
		expect(pageHasGap([], 500)).toBe(true);
	});

	test("overlap or a last page means no gap", () => {
		expect(pageHasGap([r(10), r(9)], 9)).toBe(false);
		expect(pageHasGap([r(10)], null)).toBe(false);
		expect(pageHasGap([], null)).toBe(false);
	});
});

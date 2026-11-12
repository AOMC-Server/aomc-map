import { describe, expect, test } from "bun:test";
import type { Point } from "@aomc/shared/features";
import {
	graphFromPaths,
	lineGeometry,
	lineLength,
	loopOf,
	mergeVertex,
	pathsFromGraph,
	removeVertex,
	simplePath,
} from "./lineGraph";

const path: Point[] = [
	[0, 0],
	[10, 0],
	[10, 10],
	[20, 10],
];
const loop: Point[] = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 0],
];
/** A road from (0, 0) east to (20, 0), with a branch north from (10, 0). */
const fork: Point[][] = [
	[
		[0, 0],
		[10, 0],
		[20, 0],
	],
	[
		[10, 0],
		[10, -10],
	],
];

const roundTrip = (paths: Point[][]) => pathsFromGraph(graphFromPaths(paths));
const edgeCount = (paths: Point[][]) =>
	paths.reduce((n, p) => n + p.length - 1, 0);
/** The segments of some paths, in either direction, as sorted text. */
const segments = (paths: Point[][]) =>
	paths
		.flatMap((p) =>
			p.slice(1).map((b, i) => [String(p[i]), String(b)].sort().join(" ")),
		)
		.sort();

describe("graphFromPaths", () => {
	test("points in the same block become one point", () => {
		const g = graphFromPaths(fork);
		expect(g.points).toHaveLength(4);
		expect(g.edges).toHaveLength(3);
	});

	test("a loop closes on its first point", () => {
		const g = graphFromPaths([loop]);
		expect(g.points).toHaveLength(3);
		expect(g.edges).toHaveLength(3);
	});

	test("repeated points and segments count once", () => {
		const g = graphFromPaths([
			[
				[0, 0],
				[0, 0],
				[5, 0],
				[0, 0],
			],
		]);
		expect(g.points).toHaveLength(2);
		expect(g.edges).toEqual([[0, 1]]);
	});
});

describe("pathsFromGraph", () => {
	test("a plain path and a loop come back as they went in", () => {
		expect(roundTrip([path])).toEqual([path]);
		expect(roundTrip([loop])).toEqual([loop]);
	});

	test("a fork needs two paths, and covers every segment once", () => {
		const out = roundTrip(fork);
		expect(out).toHaveLength(2);
		expect(edgeCount(out)).toBe(3);
		expect(segments(out)).toEqual(segments(fork));
	});

	test("a loop with a tail is one path", () => {
		const lollipop: Point[][] = [
			loop,
			[
				[10, 10],
				[30, 30],
			],
		];
		const out = roundTrip(lollipop);
		expect(out).toHaveLength(1);
		expect(segments(out)).toEqual(segments(lollipop));
	});

	test("separate parts are separate paths", () => {
		const parts: Point[][] = [
			path,
			[
				[100, 100],
				[200, 100],
			],
		];
		expect(roundTrip(parts)).toEqual(parts);
	});

	test("points without segments are left out", () => {
		expect(
			pathsFromGraph({
				points: [
					[0, 0],
					[1, 1],
				],
				edges: [],
			}),
		).toEqual([]);
	});
});

describe("removeVertex", () => {
	test("a point in the middle of a path joins its neighbours", () => {
		const g = removeVertex(graphFromPaths([path]), 1);
		expect(pathsFromGraph(g)).toEqual([
			[
				[0, 0],
				[10, 10],
				[20, 10],
			],
		]);
	});

	test("an end just goes", () => {
		const g = removeVertex(graphFromPaths([path]), 3);
		expect(pathsFromGraph(g)).toEqual([path.slice(0, 3)]);
	});

	test("a fork comes apart, and ends left alone go too", () => {
		const g = removeVertex(graphFromPaths(fork), 1);
		expect(g.points).toEqual([]);
		expect(g.edges).toEqual([]);
	});

	test("a point of a loop leaves a smaller loop", () => {
		const square: Point[] = [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
			[0, 0],
		];
		const g = removeVertex(graphFromPaths([square]), 2);
		expect(pathsFromGraph(g)).toEqual([
			[
				[0, 0],
				[10, 0],
				[0, 10],
				[0, 0],
			],
		]);
	});
});

test("mergeVertex closes a path into a loop", () => {
	const g = graphFromPaths([path]);
	const merged = mergeVertex(g, 3, 0);
	expect(merged.points).toHaveLength(3);
	expect(pathsFromGraph(merged)).toEqual([
		[
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 0],
		],
	]);
});

test("lineLength adds up every segment once", () => {
	expect(lineLength(graphFromPaths(fork))).toBe(30);
});

test("lineGeometry keeps a single path in the plain form", () => {
	expect(lineGeometry([path])).toEqual(path);
	expect(lineGeometry(fork)).toEqual(fork);
});

describe("loopOf and simplePath", () => {
	test("a loop is a loop, in order from its first point", () => {
		expect(loopOf(graphFromPaths([loop]))).toEqual(loop.slice(0, 3));
		expect(simplePath(graphFromPaths([loop]))).toBeNull();
	});

	test("a plain path is a simple path from one end to the other", () => {
		expect(simplePath(graphFromPaths([path]))).toEqual(path);
		expect(loopOf(graphFromPaths([path]))).toBeNull();
	});

	test("forks, loops with tails and separate parts are neither", () => {
		const lollipop = graphFromPaths([
			loop,
			[
				[10, 10],
				[30, 30],
			],
		]);
		for (const g of [graphFromPaths(fork), lollipop]) {
			expect(loopOf(g)).toBeNull();
			expect(simplePath(g)).toBeNull();
		}
		const parts = graphFromPaths([
			path,
			[
				[100, 100],
				[200, 100],
			],
		]);
		expect(simplePath(parts)).toBeNull();
	});
});

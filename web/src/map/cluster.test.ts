import { describe, expect, test } from "bun:test";
import { ClusterIndex } from "./cluster";

const opts = { radiusPx: 48, minLevel: -2, maxLevel: 12 };
const pins = (coords: [number, number][]) =>
	coords.map(([x, z], i) => ({ x, z, item: i }));

describe("ClusterIndex", () => {
	test("pins that are far apart stay single, close ones merge", () => {
		// Level 0: radius 48 blocks.
		const index = new ClusterIndex(
			pins([
				[0, 0],
				[20, 0],
				[500, 500],
			]),
			opts,
		);
		const nodes = index.nodes(0);
		expect(nodes).toHaveLength(2);
		expect(nodes.map((n) => n.count).sort()).toEqual([1, 2]);
		expect(nodes.find((n) => n.count === 1)?.item).toBe(2);
	});

	test("a cluster sits at the centre of its pins and covers them", () => {
		const [c] = new ClusterIndex(
			pins([
				[0, 0],
				[30, 10],
				[10, 20],
			]),
			opts,
		).nodes(0);
		expect(c?.count).toBe(3);
		expect(c?.x).toBeCloseTo(40 / 3, 9);
		expect(c?.z).toBeCloseTo(10, 9);
		expect(c?.bounds).toEqual({ minX: 0, minZ: 0, maxX: 30, maxZ: 20 });
	});

	test("zooming out only merges: every level keeps all pins, and never has more nodes", () => {
		const coords: [number, number][] = [];
		for (let i = 0; i < 200; i++)
			coords.push([(i * 7919) % 3000, (i * 104729) % 2500]);
		const index = new ClusterIndex(pins(coords), opts);
		let last = Number.POSITIVE_INFINITY;
		for (let level = -2; level <= 12; level++) {
			const nodes = index.nodes(level);
			expect(nodes.reduce((sum, n) => sum + n.count, 0)).toBe(200);
			expect(nodes.length).toBeLessThanOrEqual(last);
			last = nodes.length;
		}
		expect(index.nodes(12)).toHaveLength(1);
	});

	test("pins in the same block merge at every level", () => {
		const index = new ClusterIndex(
			pins([
				[5, 5],
				[5, 5],
			]),
			opts,
		);
		for (let level = -2; level <= 4; level++)
			expect(index.nodes(level)).toHaveLength(1);
	});

	test("the result does not depend on how often it is asked for", () => {
		const coords: [number, number][] = [];
		for (let i = 0; i < 100; i++) coords.push([(i * 37) % 400, (i * 91) % 300]);
		const a = new ClusterIndex(pins(coords), opts);
		const b = new ClusterIndex(pins(coords), opts);
		b.nodes(5);
		b.nodes(0);
		expect(a.nodes(3)).toEqual(b.nodes(3));
	});

	test("levels are clamped, and no pins or one pin are fine", () => {
		const index = new ClusterIndex(pins([[1, 1]]), opts);
		expect(index.nodes(-10)).toHaveLength(1);
		expect(index.nodes(99)).toHaveLength(1);
		expect(new ClusterIndex([], opts).nodes(0)).toEqual([]);
		expect(index.singles()[0]?.item).toBe(0);
	});
});

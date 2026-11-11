import { describe, expect, test } from "bun:test";
import {
	axisTicks,
	buildAxis,
	clusterByX,
	eventAt,
	eventForRev,
	eventNearest,
	filterRevisions,
	groupByDay,
	inBreak,
	outOfOrder,
	type TimelineRevision,
	timelineEvents,
	timeToU,
	uToTime,
	viewBounds,
	yearMarks,
} from "./timeline";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 1, 10);

function rev(
	id: number,
	r: number | null,
	at: number,
	extra: Partial<TimelineRevision> = {},
): TimelineRevision {
	return {
		id,
		rev: r,
		kind: "upload",
		status: "done",
		authorId: "a",
		bbox: { minX: 0, minZ: 0, maxX: 15, maxZ: 15 },
		exportedAt: at,
		createdAt: T0 + 300 * DAY,
		...extra,
	};
}

describe("viewBounds and filterRevisions", () => {
	test("the camera's blocks", () => {
		expect(
			viewBounds(
				{ centerX: 100, centerZ: -50, zoom: 1 },
				{ width: 200, height: 100 },
			),
		).toEqual({ minX: -100, minZ: -150, maxX: 300, maxZ: 50 });
	});

	test("in view by bounding box, mine by author", () => {
		const a = rev(1, 1, T0);
		const b = rev(2, 2, T0, {
			bbox: { minX: 1000, minZ: 1000, maxX: 1100, maxZ: 1100 },
			authorId: "b",
		});
		const c = rev(3, null, T0, { bbox: null, status: "failed" });
		const all = [a, b, c];
		const view = { minX: -10, minZ: -10, maxX: 10, maxZ: 10 };
		expect(filterRevisions(all, { inView: null, authorId: null })).toEqual(all);
		expect(filterRevisions(all, { inView: view, authorId: null })).toEqual([a]);
		expect(filterRevisions(all, { inView: null, authorId: "b" })).toEqual([b]);
		expect(filterRevisions(all, { inView: view, authorId: "b" })).toEqual([]);
	});
});

describe("events", () => {
	const a = rev(1, 1, T0);
	const b = rev(2, 2, T0 + 2 * DAY);
	// Exported between the two, but published after both.
	const late = rev(3, 3, T0 + DAY);
	const pending = rev(4, null, T0 + 3 * DAY, { status: "pending" });
	const all = [a, b, late, pending];

	test("only finished uploads, by time", () => {
		expect(timelineEvents(all).map((e) => e.id)).toEqual([1, 3, 2]);
	});

	test("out of order: published after a newer export", () => {
		expect([...outOfOrder(all)]).toEqual([3]);
	});

	test("eventAt picks the newest made by then", () => {
		const events = timelineEvents(all);
		expect(eventAt(events, T0 - 1)).toBeNull();
		expect(eventAt(events, T0)?.id).toBe(1);
		expect(eventAt(events, T0 + 1.5 * DAY)?.id).toBe(3);
		expect(eventAt(events, T0 + 10 * DAY)?.id).toBe(2);
	});

	test("eventNearest picks the closest, whichever side it is on", () => {
		const events = timelineEvents(all);
		const at = (t: number) => eventNearest(events, t, (e) => e.exportedAt ?? 0);
		expect(at(T0 - 5 * DAY)?.id).toBe(1);
		expect(at(T0 + 0.4 * DAY)?.id).toBe(1);
		expect(at(T0 + 0.6 * DAY)?.id).toBe(3);
		expect(at(T0 + 1.6 * DAY)?.id).toBe(2);
		expect(at(T0 + 9 * DAY)?.id).toBe(2);
		expect(eventNearest([], 0, () => 0)).toBeNull();
		// A tie goes to the newer revision.
		const tie = timelineEvents([rev(1, 1, T0), rev(2, 2, T0)]);
		expect(eventNearest(tie, T0, (e) => e.exportedAt ?? 0)?.id).toBe(2);
	});

	test("eventForRev is the newest published one", () => {
		const events = timelineEvents(all);
		expect(eventForRev(events, 0)).toBeNull();
		expect(eventForRev(events, 2)?.id).toBe(2);
		expect(eventForRev(events, null)?.id).toBe(3);
	});
});

describe("axis", () => {
	test("is linear without long gaps, and invertible", () => {
		const axis = buildAxis([T0, T0 + DAY, T0 + 2 * DAY]);
		expect(axis.breaks).toEqual([]);
		const u = timeToU(axis, T0 + DAY);
		expect(timeToU(axis, T0 + 2 * DAY) - u).toBe(DAY);
		expect(uToTime(axis, u)).toBe(T0 + DAY);
	});

	test("squeezes a long quiet gap", () => {
		const times = [T0, T0 + DAY, T0 + 2 * DAY, T0 + 200 * DAY];
		const axis = buildAxis(times);
		expect(axis.breaks.length).toBe(1);
		expect(axis.length).toBeLessThan(100 * DAY);
		const mid = timeToU(axis, T0 + 100 * DAY);
		expect(inBreak(axis, mid)).toBe(true);
		for (const t of [...times, T0 + 100 * DAY])
			expect(uToTime(axis, timeToU(axis, t))).toBeCloseTo(t, -1);
		// Order is kept.
		const us = times.map((t) => timeToU(axis, t));
		expect([...us].sort((x, y) => x - y)).toEqual(us);
	});

	test("ticks are spaced and outside breaks", () => {
		const axis = buildAxis([T0, T0 + 30 * DAY]);
		const ticks = axisTicks(axis, 0, axis.length, 600);
		expect(ticks.length).toBeGreaterThan(2);
		for (const [i, t] of ticks.entries()) {
			if (i > 0) expect(t.t).toBeGreaterThan((ticks[i - 1] as { t: number }).t);
			expect(new Date(t.t).getUTCHours()).toBe(0);
		}
	});

	test("ticks stay on the same dates while panning", () => {
		const axis = buildAxis([T0, T0 + 120 * DAY]);
		const span = axis.length / 4;
		const seen = new Map<number, string>();
		for (let off = 0; off < axis.length - span; off += span / 37) {
			for (const t of axisTicks(axis, off, off + span, 500)) {
				// The same date always gets the same label, and lands where it should.
				expect(seen.get(t.t) ?? t.label).toBe(t.label);
				seen.set(t.t, t.label);
			}
		}
		// A multi-day grid is fixed, not counted from the window's left edge.
		const a = axisTicks(axis, 0, span, 500).map((t) => t.t);
		const b = axisTicks(axis, span / 7, span + span / 7, 500).map((t) => t.t);
		const common = a.filter((t) => b.includes(t));
		expect(common.length).toBeGreaterThan(3);
		const gaps = new Set(a.slice(1).map((t, i) => t - (a[i] as number)));
		expect(gaps.size).toBe(1);
	});

	test("ticks slide smoothly: the same ticks, moved by the pan", () => {
		const axis = buildAxis([T0, T0 + 60 * DAY]);
		const span = axis.length / 3;
		const at = (off: number) =>
			new Map(axisTicks(axis, off, off + span, 400).map((t) => [t.t, t.u]));
		const a = at(span / 3);
		const b = at(span / 3 + 5);
		for (const [t, u] of a) if (b.has(t)) expect(b.get(t)).toBe(u);
		// Nothing pops in or out in the middle of the visible part.
		const inside = [...a.keys()].filter(
			(t) =>
				(a.get(t) as number) > span / 3 + 10 && (a.get(t) as number) < span,
		);
		for (const t of inside) expect(b.has(t)).toBe(true);
	});

	test("year marks: the year at the left, then each 1 January", () => {
		const axis = buildAxis([Date.UTC(2025, 10, 1), Date.UTC(2027, 2, 1)]);
		const { first, marks } = yearMarks(axis, 0, axis.length);
		expect(first).toBe(2025);
		expect(marks.map((m) => m.year)).toEqual([2026, 2027]);
		expect(marks[0]?.u).toBeCloseTo(timeToU(axis, Date.UTC(2026, 0, 1)));
		expect(yearMarks(axis, marks[0]?.u as number, axis.length).first).toBe(
			2026,
		);
	});

	test("an empty or single-point axis still has length", () => {
		expect(buildAxis([]).length).toBeGreaterThan(0);
		expect(buildAxis([T0]).length).toBeGreaterThan(0);
	});
});

test("clusterByX merges close points", () => {
	const groups = clusterByX(
		[{ x: 0 }, { x: 4 }, { x: 20 }, { x: 22 }, { x: 40 }],
		8,
	);
	expect(groups.map((g) => g.items.length)).toEqual([2, 2, 1]);
	expect(groups[0]?.x).toBe(2);
});

test("groupByDay, newest first", () => {
	const items = [rev(1, 1, T0), rev(2, 2, T0 + DAY), rev(3, 3, T0 + 1000)];
	const groups = groupByDay(items, (r) =>
		new Date(r.exportedAt ?? 0).toISOString().slice(0, 10),
	);
	expect(groups.map((g) => [g.day, g.items.map((r) => r.id)])).toEqual([
		["2026-02-11", [2]],
		["2026-02-10", [3, 1]],
	]);
});

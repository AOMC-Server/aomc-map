import { DAY, HOUR } from "@aomc/shared/time";
import { type Size, screenToBlock, type View } from "@aomc/shared/view";
import { type Bounds, intersects } from "./map/geometry";

/** The parts of a revision the timeline and the upload log work with. */
export type TimelineRevision = {
	id: number;
	rev: number | null;
	kind: string;
	status: string;
	authorId: string;
	bbox: Bounds | null;
	exportedAt: number | null;
	createdAt: number;
};

/** When an upload counts as made: its export time, or else when it was uploaded (as the server stacks tiles). */
export const eventTime = (r: TimelineRevision) => r.exportedAt ?? r.createdAt;

/** The blocks the camera sees. */
export function viewBounds(view: View, size: Size): Bounds {
	const a = screenToBlock(view, size, 0, 0);
	const b = screenToBlock(view, size, size.width, size.height);
	return { minX: a.x, minZ: a.z, maxX: b.x, maxZ: b.z };
}

export type HistoryFilter = {
	/** Only uploads whose area overlaps this (null = everything). */
	inView: Bounds | null;
	/** Only uploads by this user (null = everyone's). */
	authorId: string | null;
};

/** Revisions that pass the filter; uploads without an area are never "in view". */
export function filterRevisions<R extends TimelineRevision>(
	revisions: readonly R[],
	filter: HistoryFilter,
): R[] {
	return revisions.filter(
		(r) =>
			(filter.authorId === null || r.authorId === filter.authorId) &&
			(filter.inView === null ||
				(r.bbox !== null && intersects(r.bbox, filter.inView))),
	);
}

/** Finished uploads, which are the points one can look at on the timeline, oldest first. */
export function timelineEvents<R extends TimelineRevision>(
	revisions: readonly R[],
): (R & { rev: number })[] {
	return revisions
		.filter(
			(r): r is R & { rev: number } =>
				r.kind === "upload" && r.status === "done" && r.rev !== null,
		)
		.sort((a, b) => eventTime(a) - eventTime(b) || a.rev - b.rev);
}

/**
 * Uploads that were made (exported) before some upload that was published ahead of them. Looking
 * at one of them also shows those newer exports, so the map is not quite "as of" its date.
 */
export function outOfOrder(
	revisions: readonly TimelineRevision[],
): Set<number> {
	const byRev = timelineEvents(revisions).sort((a, b) => a.rev - b.rev);
	const out = new Set<number>();
	let latest = Number.NEGATIVE_INFINITY;
	for (const r of byRev) {
		const t = eventTime(r);
		if (t < latest) out.add(r.id);
		latest = Math.max(latest, t);
	}
	return out;
}

/**
 * The event closest to a point, `posOf` giving where each one is (pixels on screen, say), so the
 * choice follows what is drawn. On a tie the newer revision wins.
 */
export function eventNearest<E extends { rev: number }>(
	events: readonly E[],
	pos: number,
	posOf: (e: E) => number,
): E | null {
	let best: E | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const e of events) {
		const d = Math.abs(posOf(e) - pos);
		if (d < bestDist || (d === bestDist && best && e.rev > best.rev)) {
			best = e;
			bestDist = d;
		}
	}
	return best;
}

/**
 * The event that the map at `rev` belongs to: the newest published one (null = before all of
 * them). `rev` null means the latest.
 */
export function eventForRev<E extends { rev: number }>(
	events: readonly E[],
	rev: number | null,
): E | null {
	let best: E | null = null;
	for (const e of events) {
		if (rev !== null && e.rev > rev) continue;
		if (!best || e.rev > best.rev) best = e;
	}
	return best;
}

/**
 * The revisions the keyboard steps through, in the order the timeline shows them: before the
 * first upload, each upload by export time, then the latest (null). The head is the latest, so
 * it only counts there, at the end; every other revision appears once.
 */
export function revisionStops<E extends { rev: number }>(
	events: readonly E[],
	head: number,
): (number | null)[] {
	const first = events.reduce((m, e) => Math.min(m, e.rev), head);
	const stops = [Math.max(first - 1, 0), ...events.map((e) => e.rev)].map(
		(r) => (r >= head ? null : r),
	);
	stops.push(null);
	return stops.filter((s, i) => s !== null || i === stops.length - 1);
}

/** Where `rev` (null = latest) sits among `revisionStops`. */
export function stopIndex<E extends { rev: number }>(
	events: readonly E[],
	head: number,
	rev: number | null,
): number {
	const stops = revisionStops(events, head);
	if (rev === null || rev >= head) return stops.length - 1;
	const e = eventForRev(events, rev);
	return e ? Math.max(stops.indexOf(e.rev), 0) : 0;
}

/**
 * The revision one stop before (`dir` -1) or after (1) `rev`, or undefined at either end.
 * null is the latest.
 */
export function stepRevision<E extends { rev: number }>(
	events: readonly E[],
	head: number,
	rev: number | null,
	dir: -1 | 1,
): number | null | undefined {
	const stops = revisionStops(events, head);
	const i = stopIndex(events, head, rev) + dir;
	return i >= 0 && i < stops.length ? stops[i] : undefined;
}

// Axis ---------------------------------------------------------------------------------------

/** A stretch of the axis: real time is linear in it, `u` is the position along the axis. */
type Segment = { t0: number; t1: number; u0: number; u1: number };

/** Maps time to a position `u`, with long quiet gaps squeezed so that busy stretches stay readable. */
export type Axis = {
	segments: Segment[];
	/** Squeezed gaps, as ranges of `u`, where the axis is drawn broken. */
	breaks: { u0: number; u1: number }[];
	length: number;
};

/**
 * Builds an axis over `times`. A gap is squeezed when it is longer than a fifth of the whole span
 * (and two days), so a few early uploads do not push everything else into a corner.
 */
export function buildAxis(times: readonly number[]): Axis {
	const sorted = [...new Set(times)].sort((a, b) => a - b);
	if (sorted.length === 0) {
		const now = Date.now();
		sorted.push(now - DAY, now);
	}
	const first = sorted[0] as number;
	const last = sorted.at(-1) as number;
	const span = Math.max(last - first, HOUR);
	const pad = Math.max(span * 0.03, HOUR);
	const squeezed = Math.max(span * 0.04, HOUR);
	const threshold = Math.max(span * 0.2, 2 * DAY);

	const segments: Segment[] = [];
	const breaks: Axis["breaks"] = [];
	let t = first - pad;
	let u = 0;
	const real = (to: number) => {
		if (to <= t) return;
		segments.push({ t0: t, t1: to, u0: u, u1: u + (to - t) });
		u += to - t;
		t = to;
	};
	for (let i = 0; i + 1 < sorted.length; i++) {
		const a = sorted[i] as number;
		const b = sorted[i + 1] as number;
		const gap = b - a;
		if (gap <= threshold || gap <= 3 * squeezed) continue;
		const margin = squeezed;
		real(a + margin);
		segments.push({ t0: t, t1: b - margin, u0: u, u1: u + squeezed });
		breaks.push({ u0: u, u1: u + squeezed });
		u += squeezed;
		t = b - margin;
	}
	real(last + pad);
	return { segments, breaks, length: u };
}

export function timeToU(axis: Axis, t: number): number {
	const segs = axis.segments;
	const first = segs[0] as Segment;
	const last = segs.at(-1) as Segment;
	if (t <= first.t0) return first.u0 - (first.t0 - t);
	if (t >= last.t1) return last.u1 + (t - last.t1);
	for (const s of segs) {
		if (t <= s.t1)
			return s.u0 + ((t - s.t0) / (s.t1 - s.t0 || 1)) * (s.u1 - s.u0);
	}
	return last.u1;
}

export function uToTime(axis: Axis, u: number): number {
	const segs = axis.segments;
	const first = segs[0] as Segment;
	const last = segs.at(-1) as Segment;
	if (u <= first.u0) return first.t0 - (first.u0 - u);
	if (u >= last.u1) return last.t1 + (u - last.u1);
	for (const s of segs) {
		if (u <= s.u1)
			return s.t0 + ((u - s.u0) / (s.u1 - s.u0 || 1)) * (s.t1 - s.t0);
	}
	return last.t1;
}

/** Whether `u` falls in a squeezed gap. */
export const inBreak = (axis: Axis, u: number) =>
	axis.breaks.some((b) => u > b.u0 && u < b.u1);

const STEPS: {
	ms: number;
	unit: "hour" | "day" | "month" | "year";
	n: number;
}[] = [
	{ ms: HOUR, unit: "hour", n: 1 },
	{ ms: 3 * HOUR, unit: "hour", n: 3 },
	{ ms: 6 * HOUR, unit: "hour", n: 6 },
	{ ms: 12 * HOUR, unit: "hour", n: 12 },
	{ ms: DAY, unit: "day", n: 1 },
	{ ms: 2 * DAY, unit: "day", n: 2 },
	{ ms: 7 * DAY, unit: "day", n: 7 },
	{ ms: 14 * DAY, unit: "day", n: 14 },
	{ ms: 30 * DAY, unit: "month", n: 1 },
	{ ms: 91 * DAY, unit: "month", n: 3 },
	{ ms: 182 * DAY, unit: "month", n: 6 },
	{ ms: 365 * DAY, unit: "year", n: 1 },
];

export type Tick = { t: number; u: number; label: string };

/** Days since 1970-01-01 of the local calendar date at `t`. */
const localDay = (t: number) => {
	const d = new Date(t);
	return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};

/** Local midnight at the start of day number `day` (see `localDay`). */
const fromLocalDay = (day: number) => {
	const d = new Date(day * DAY);
	return new Date(
		d.getUTCFullYear(),
		d.getUTCMonth(),
		d.getUTCDate(),
	).getTime();
};

/**
 * The first tick after `t`. Ticks sit on a fixed grid of the local calendar (days counted from
 * the epoch, weeks from a Monday), never relative to what is on screen, so they stay put while
 * panning.
 */
function tickAfter(t: number, step: (typeof STEPS)[number]): number {
	const d = new Date(t);
	switch (step.unit) {
		case "hour": {
			const hour = (Math.floor(d.getHours() / step.n) + 1) * step.n;
			const next = new Date(
				d.getFullYear(),
				d.getMonth(),
				d.getDate(),
				hour,
			).getTime();
			// A daylight saving change can land the next hour on or before `t`.
			return next > t ? next : next + step.n * HOUR;
		}
		case "day": {
			// 1970-01-01 was a Thursday; a 7-day grid starting 4 days later falls on Mondays.
			const offset = step.n === 7 ? 4 : 0;
			const day = localDay(t);
			return fromLocalDay(
				(Math.floor((day - offset) / step.n) + 1) * step.n + offset,
			);
		}
		case "month": {
			const next =
				(Math.floor((d.getFullYear() * 12 + d.getMonth()) / step.n) + 1) *
				step.n;
			return new Date(Math.floor(next / 12), next % 12, 1).getTime();
		}
		case "year":
			return new Date(d.getFullYear() + step.n, 0, 1).getTime();
	}
}

/** Years are on their own row (see `yearMarks`), so a yearly tick is just a line. */
function tickLabel(t: number, step: (typeof STEPS)[number]): string {
	const d = new Date(t);
	if (step.unit === "hour" && (d.getHours() !== 0 || d.getMinutes() !== 0))
		return d.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	if (step.unit === "hour" || step.unit === "day")
		return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
	if (step.unit === "month")
		return d.toLocaleDateString(undefined, { month: "short" });
	return "";
}

/**
 * Calendar ticks for the part of the axis from `u0` to `u1`, drawn `width` pixels wide. Ticks
 * just outside that part are included too (they are what slides in while panning), and which
 * ticks there are depends only on the zoom, never on where the window is.
 */
export function axisTicks(
	axis: Axis,
	u0: number,
	u1: number,
	width: number,
	minGapPx = 64,
): Tick[] {
	if (u1 <= u0 || width <= 0) return [];
	const msPerPx = (u1 - u0) / width;
	const step =
		STEPS.find((s) => s.ms / msPerPx >= minGapPx) ?? (STEPS.at(-1) as never);
	const margin = (u1 - u0) / 2;
	const end = uToTime(axis, u1 + margin);
	const out: Tick[] = [];
	let t = tickAfter(uToTime(axis, u0 - margin) - 1, step);
	for (let i = 0; t <= end && i < 1000; i++) {
		const u = timeToU(axis, t);
		if (!inBreak(axis, u)) out.push({ t, u, label: tickLabel(t, step) });
		t = tickAfter(t, step);
	}
	return out;
}

/** The year at the left edge of `u0`, and each new year (1 January) after it up to `u1`. */
export function yearMarks(
	axis: Axis,
	u0: number,
	u1: number,
): { first: number; marks: { year: number; u: number }[] } {
	const from = uToTime(axis, u0);
	const to = uToTime(axis, u1);
	const first = new Date(from).getFullYear();
	const newYear = (y: number) => new Date(y, 0, 1).getTime();
	const marks: { year: number; u: number }[] = [];
	for (let y = first + 1; newYear(y) <= to && y < first + 200; y++) {
		const u = timeToU(axis, newYear(y));
		if (u > u0 && u < u1) marks.push({ year: y, u });
	}
	return { first, marks };
}

/** Groups points (sorted by x) that are closer than `minGap` pixels to the first of their group. */
export function clusterByX<P extends { x: number }>(
	points: readonly P[],
	minGap: number,
): { x: number; items: P[] }[] {
	const groups: { x: number; items: P[] }[] = [];
	for (const p of points) {
		const g = groups.at(-1);
		if (g && p.x - (g.items[0] as P).x < minGap) g.items.push(p);
		else groups.push({ x: p.x, items: [p] });
	}
	for (const g of groups) {
		g.x = g.items.reduce((sum, p) => sum + p.x, 0) / g.items.length;
	}
	return groups;
}

/** Revisions grouped by the day they were made, newest first. */
export function groupByDay<R extends TimelineRevision>(
	revisions: readonly R[],
	dayOf: (r: R) => string,
): { day: string; items: R[] }[] {
	const sorted = [...revisions].sort(
		(a, b) => eventTime(b) - eventTime(a) || b.id - a.id,
	);
	const groups: { day: string; items: R[] }[] = [];
	for (const r of sorted) {
		const day = dayOf(r);
		const g = groups.at(-1);
		if (g && g.day === day) g.items.push(r);
		else groups.push({ day, items: [r] });
	}
	return groups;
}

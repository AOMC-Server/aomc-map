import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { setRev } from "../controller";
import {
	currentMap,
	highlightedUpload,
	hoveredRevision,
	type RevisionInfo,
	rev,
} from "../state";
import { HOUR } from "../time";
import {
	axisTicks,
	buildAxis,
	clusterByX,
	eventForRev,
	eventNearest,
	eventTime,
	revisionStops,
	stepRevision,
	stopIndex,
	timeToU,
	uToTime,
	yearMarks,
} from "../timeline";
import { formatEventTime } from "./format";

type Event = RevisionInfo & { rev: number };

/** Markers closer than this many pixels are drawn as one. */
const CLUSTER_PX = 9;
/** Room a year label needs on the axis. */
const YEAR_PX = 36;
/** How close (pixels) the pointer must be to a marker to pick it rather than the time under it. */
const SNAP_PX = 7;

/** Points at an upload from the timeline or the log: both highlight it and the map outlines it. */
export function pointAt(r: RevisionInfo | null, from: "timeline" | "log") {
	hoveredRevision.value = r ? { id: r.id, from } : null;
	highlightedUpload.value = r;
}

const markerHeight = (r: RevisionInfo) =>
	10 + Math.min(16, 4 * Math.log2(1 + r.fileCount));

const newest = (items: Event[]) =>
	items.reduce((a, b) =>
		eventTime(b) > eventTime(a) ||
		(eventTime(b) === eventTime(a) && b.rev > a.rev)
			? b
			: a,
	);

/**
 * A time axis over the uploads (by export date), with a playhead for the revision being looked
 * at. Click or drag on it to look at the map as of a moment; wheel zooms, dragging the dates
 * underneath pans, double-click zooms in.
 */
export function Timeline(props: {
	/** Finished uploads, oldest first. */
	events: Event[];
	/** Uploads still being processed, drawn but not selectable. */
	pending: RevisionInfo[];
	outOfOrder: Set<number>;
	describe: (r: RevisionInfo) => string;
}) {
	const { events, pending, outOfOrder } = props;
	const track = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	/** The visible stretch of time, or null to fit everything. */
	const [range, setRange] = useState<{ t0: number; t1: number } | null>(null);
	/** The card shown over a marker: the uploads there, and the one it describes. */
	const [hover, setHover] = useState<{
		x: number;
		items: Event[];
		item: Event;
	} | null>(null);

	useEffect(() => {
		const el = track.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		setWidth(el.clientWidth);
		return () => ro.disconnect();
	}, []);

	const axis = useMemo(
		() => buildAxis([...events, ...pending].map(eventTime)),
		[events, pending],
	);
	const full = { u0: 0, u1: axis.length };
	const { u0, u1 } = range
		? { u0: timeToU(axis, range.t0), u1: timeToU(axis, range.t1) }
		: full;
	const span = Math.max(u1 - u0, 1);
	const xOf = (t: number) => ((timeToU(axis, t) - u0) / span) * width;

	const visible = events.filter((e) => {
		const x = xOf(eventTime(e));
		return x >= -CLUSTER_PX && x <= width + CLUSTER_PX;
	});
	const clusters = clusterByX(
		visible.map((e) => ({ x: xOf(eventTime(e)), e })),
		CLUSTER_PX,
	).map((c) => ({ x: c.x, items: c.items.map((p) => p.e) }));

	const head = currentMap.value?.map.headRev ?? 0;
	const latest = rev.value === null;
	const current = latest ? null : eventForRev(events, rev.value);
	const playheadX = latest
		? events.length
			? xOf(eventTime(events.at(-1) as Event))
			: width
		: current
			? xOf(eventTime(current))
			: xOf(uToTime(axis, 0));
	const stops = revisionStops(events, head);
	const position = stopIndex(events, head, rev.value);
	const beforeRev = stops[0] as number;
	const step = (dir: -1 | 1) => {
		const target = stepRevision(events, head, rev.value, dir);
		if (target !== undefined) setRev(target);
	};

	const zoomAround = (x: number, factor: number) => {
		const at = u0 + (x / width) * span;
		let next0 = at - (at - u0) * factor;
		let next1 = at + (u1 - at) * factor;
		if (next1 - next0 >= axis.length) return setRange(null);
		if (next1 - next0 < HOUR) return;
		if (next0 < 0) [next0, next1] = [0, next1 - next0];
		if (next1 > axis.length)
			[next0, next1] = [next0 - (next1 - axis.length), axis.length];
		setRange({ t0: uToTime(axis, next0), t1: uToTime(axis, next1) });
	};

	/** Shows the stretch from `from0` to `from1` (axis positions) moved by `dx` pixels. */
	const panFrom = (from0: number, from1: number, dx: number) => {
		const w = from1 - from0;
		const du = Math.max(
			-from0,
			Math.min(axis.length - from1, (-dx / width) * w),
		);
		setRange({
			t0: uToTime(axis, from0 + du),
			t1: uToTime(axis, from1 + du),
		});
	};
	const panBy = (dx: number) => {
		if (range) panFrom(u0, u1, dx);
	};

	const clusterNear = (x: number) => {
		let best: (typeof clusters)[number] | null = null;
		for (const c of clusters) {
			if (
				Math.abs(c.x - x) <= SNAP_PX &&
				(!best || Math.abs(c.x - x) < Math.abs(best.x - x))
			)
				best = c;
		}
		return best;
	};

	/** Points the card (and the log and map) at an upload, or at nothing. */
	const showCard = (item: Event | null) => {
		const c = item ? clusters.find((c) => c.items.includes(item)) : null;
		setHover(
			item
				? {
						x: c?.x ?? xOf(eventTime(item)),
						items: c?.items ?? [item],
						item,
					}
				: null,
		);
		if (item?.id !== hoveredRevision.value?.id) pointAt(item, "timeline");
	};

	/** Looks at the upload closest to `x` (as drawn, on either side); the card follows. */
	const scrubTo = (x: number) => {
		const e = eventNearest(events, x, (e) => xOf(eventTime(e)));
		setRev(e ? e.rev : beforeRev);
		showCard(e);
	};

	const localX = (e: PointerEvent | MouseEvent | WheelEvent) =>
		e.clientX - (track.current?.getBoundingClientRect().left ?? 0);

	/** A pan is measured from where it started, so no movement is lost between renders. */
	const drag = useRef<{
		mode: "scrub" | "pan";
		x: number;
		u0: number;
		u1: number;
	} | null>(null);

	const onTrackDown = (e: PointerEvent, mode: "scrub" | "pan") => {
		if (e.button !== 0) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag.current = { mode, x: localX(e), u0, u1 };
		if (mode === "scrub" && events.length) scrubTo(localX(e));
	};
	const onMove = (e: PointerEvent) => {
		const x = localX(e);
		const d = drag.current;
		if (d?.mode === "scrub") scrubTo(x);
		else if (d?.mode === "pan" && range) panFrom(d.u0, d.u1, x - d.x);
		if (!d) {
			const c = clusterNear(x);
			showCard(c ? newest(c.items) : null);
		}
	};
	const onUp = (e: PointerEvent) => {
		const was = drag.current;
		drag.current = null;
		// A drag that ends away from the track leaves nothing to point at.
		if (was?.mode === "scrub") {
			const box = track.current?.getBoundingClientRect();
			if (
				box &&
				(e.clientX < box.left ||
					e.clientX > box.right ||
					e.clientY < box.top ||
					e.clientY > box.bottom)
			)
				showCard(null);
		}
	};
	const onLeave = () => {
		if (drag.current) return;
		setHover(null);
		if (hoveredRevision.value?.from === "timeline") pointAt(null, "timeline");
	};

	const onWheel = (e: WheelEvent) => {
		e.preventDefault();
		if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)
			panBy(-(e.deltaX || e.deltaY));
		else zoomAround(localX(e), Math.exp(e.deltaY * 0.0015));
	};

	const onKey = (e: KeyboardEvent) => {
		const keys: Record<string, () => void> = {
			ArrowLeft: () => step(-1),
			ArrowRight: () => step(1),
			Home: () => setRev(events[0]?.rev ?? null),
			End: () => setRev(null),
			Escape: () => setRev(null),
			"+": () => zoomAround(playheadX, 0.5),
			"=": () => zoomAround(playheadX, 0.5),
			"-": () => zoomAround(playheadX, 2),
		};
		const run = keys[e.key];
		if (!run) return;
		e.preventDefault();
		e.stopPropagation();
		run();
	};

	const hovered = hoveredRevision.value;
	const ticks = axisTicks(axis, u0, u1, width);
	// The year labels sit at each 1 January; the one for the left edge stays pinned there and is
	// pushed out by the next year as it arrives, like a sticky header.
	const years = yearMarks(axis, u0, u1);
	const yearLabels = [
		{ year: years.first, x: 0 },
		...years.marks.map((m) => ({
			year: m.year,
			x: ((m.u - u0) / span) * width,
		})),
	].map((y, i, all) => ({
		...y,
		x: Math.min(y.x, (all[i + 1]?.x ?? Number.POSITIVE_INFINITY) - YEAR_PX),
	}));
	const breakXs = axis.breaks
		.map((b) => ({
			x0: ((b.u0 - u0) / span) * width,
			x1: ((b.u1 - u0) / span) * width,
		}))
		.filter((b) => b.x1 >= 0 && b.x0 <= width);
	const hoverItem = hover?.item ?? null;

	return (
		<div class="timeline">
			<div
				class="timeline-track"
				ref={track}
				tabIndex={0}
				role="slider"
				aria-label="Time line of uploads"
				aria-valuemin={0}
				aria-valuemax={stops.length - 1}
				aria-valuenow={position}
				aria-valuetext={
					latest
						? "Latest"
						: current
							? `${props.describe(current)}, ${formatEventTime(current)}`
							: "Before the first upload"
				}
				onPointerDown={(e) => onTrackDown(e, "scrub")}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerCancel={onUp}
				onPointerLeave={onLeave}
				onWheel={onWheel}
				onDblClick={(e) => zoomAround(localX(e), 0.4)}
				onKeyDown={onKey}
			>
				{breakXs.map((b) => (
					<span
						key={b.x0}
						class="timeline-break"
						style={{ left: `${b.x0}px`, width: `${b.x1 - b.x0}px` }}
						title="A long quiet stretch, squeezed"
					/>
				))}
				{latest || current || events.length === 0 ? null : (
					<span class="timeline-before" style={{ width: `${playheadX}px` }} />
				)}
				{clusters.map((c) => {
					const top = newest(c.items);
					const height = Math.max(...c.items.map(markerHeight));
					const active =
						!latest && current !== null && c.items.includes(current);
					const odd = c.items.some((r) => outOfOrder.has(r.id));
					const isHovered =
						hovered !== null && c.items.some((r) => r.id === hovered.id);
					return (
						<span
							key={top.id}
							class={`timeline-marker ${active ? "active" : ""} ${isHovered ? "hovered" : ""} ${odd ? "odd" : ""}`}
							style={{ left: `${c.x}px`, height: `${height}px` }}
						>
							{c.items.length > 1 && (
								<span class="timeline-count">{c.items.length}</span>
							)}
						</span>
					);
				})}
				{pending.map((r) => {
					const x = xOf(eventTime(r));
					if (x < 0 || x > width) return null;
					return (
						<span
							key={r.id}
							class="timeline-marker pending"
							style={{ left: `${x}px`, height: `${markerHeight(r)}px` }}
						/>
					);
				})}
				{events.length > 0 && playheadX >= 0 && playheadX <= width && (
					<span
						class={`timeline-playhead ${latest ? "latest" : ""}`}
						style={{ left: `${playheadX}px` }}
					/>
				)}
				{hover && hoverItem && (
					<span
						class="timeline-card"
						style={{
							left: `${Math.min(Math.max(hover.x, 100), width - 100)}px`,
						}}
					>
						<b>
							#{hoverItem.rev} · {props.describe(hoverItem)}
						</b>
						<span>
							{hoverItem.authorName} · {formatEventTime(hoverItem)}
						</span>
						{hover.items.length > 1 && (
							<span class="muted">
								and {hover.items.length - 1} more close by
							</span>
						)}
						{hover.items.some((r) => outOfOrder.has(r.id)) && (
							<span class="warn-text">
								⚠ Uploaded after newer exports, which the map at this point also
								shows.
							</span>
						)}
					</span>
				)}
			</div>
			<div
				class={`timeline-axis ${range ? "pannable" : ""}`}
				aria-hidden="true"
				onPointerDown={(e) => onTrackDown(e, "pan")}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerCancel={onUp}
				onWheel={onWheel}
			>
				{ticks.map((t) => {
					const x = ((t.u - u0) / span) * width;
					return (
						<span key={t.t} class="timeline-tick" style={{ left: `${x}px` }}>
							{t.label}
						</span>
					);
				})}
				{yearLabels.map((y) => (
					<span key={y.year} class="timeline-year" style={{ left: `${y.x}px` }}>
						{y.year}
					</span>
				))}
			</div>
			<div class="timeline-controls group">
				<button
					type="button"
					class="btn small"
					disabled={position <= 0}
					onClick={() => step(-1)}
					title="Previous upload (←)"
				>
					◀
				</button>
				<button
					type="button"
					class="btn small"
					disabled={position >= stops.length - 1}
					onClick={() => step(1)}
					title="Next upload (→)"
				>
					▶
				</button>
				<button
					type="button"
					class="btn small"
					disabled={latest}
					onClick={() => setRev(null)}
					title="Back to the latest map (End)"
				>
					Latest
				</button>
				<span class="spacer" />
				<button
					type="button"
					class="btn small"
					onClick={() => zoomAround(playheadX, 0.5)}
					title="Zoom in on the time line (+)"
					aria-label="Zoom in"
				>
					+
				</button>
				<button
					type="button"
					class="btn small"
					disabled={range === null}
					onClick={() => zoomAround(playheadX, 2)}
					title="Zoom out (−)"
					aria-label="Zoom out"
				>
					−
				</button>
				<button
					type="button"
					class="btn small"
					disabled={range === null}
					onClick={() => setRange(null)}
					title="Show the whole time line"
				>
					Fit
				</button>
			</div>
		</div>
	);
}

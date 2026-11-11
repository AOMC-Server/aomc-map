import { useState } from "preact/hooks";

export type ChartSeries = {
	key: string;
	label: string;
	/** A CSS colour. */
	color: string;
	values: number[];
};

const W = 640;
const H = 240;
const PAD = { left: 62, right: 12, top: 10, bottom: 26 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** A round number at or above `max`, so the axis ends on a clean value. */
export function niceMax(max: number): number {
	if (max <= 0) return 1;
	const pow = 10 ** Math.floor(Math.log10(max));
	for (const step of [1, 2, 2.5, 5, 10])
		if (step * pow >= max) return step * pow;
	return 10 * pow;
}

/** Evenly spaced indices into a list of `n`, at most `count` of them. */
function tickIndices(n: number, count: number): number[] {
	if (n <= count) return Array.from({ length: n }, (_, i) => i);
	return Array.from({ length: count }, (_, i) =>
		Math.round((i * (n - 1)) / (count - 1)),
	);
}

/**
 * A small chart: `steps` draws lines that hold their value between points (for readings taken
 * at moments), `bars` draws stacked bars, one per equally long period.
 */
export function Chart(props: {
	kind: "steps" | "bars";
	xs: number[];
	series: ChartSeries[];
	formatY: (value: number) => string;
	formatX: (x: number) => string;
	/** Fuller form of `formatX` for the tooltip (e.g. with the year); defaults to `formatX`. */
	formatTip?: (x: number) => string;
	/** Extra line in the tooltip for the point at this index. */
	note?: (index: number) => string | null;
}) {
	const { kind, xs, series, formatY, formatX } = props;
	const [hover, setHover] = useState<number | null>(null);
	const n = xs.length;
	if (n === 0) return <p class="muted">No data yet.</p>;

	const stacked = kind === "bars";
	const totals = xs.map((_, i) =>
		stacked
			? series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
			: Math.max(...series.map((s) => s.values[i] ?? 0)),
	);
	const top = niceMax(Math.max(...totals));
	const y = (v: number) => PAD.top + PLOT_H * (1 - v / top);

	const first = xs[0] as number;
	const span = (xs[n - 1] as number) - first;
	const x = (i: number) =>
		kind === "bars"
			? PAD.left + (PLOT_W * (i + 0.5)) / n
			: PAD.left +
				(span > 0 ? (PLOT_W * ((xs[i] as number) - first)) / span : PLOT_W / 2);

	const pick = (e: PointerEvent) => {
		const box = (e.currentTarget as Element).getBoundingClientRect();
		const px = ((e.clientX - box.left) / box.width) * W;
		let best = 0;
		for (let i = 1; i < n; i++)
			if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
		setHover(best);
	};

	const barW = Math.max(1, (PLOT_W / n) * 0.78);
	const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
	const hoverNote = hover === null ? null : (props.note?.(hover) ?? null);

	return (
		<div class="chart">
			<div class="chart-box">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					class="chart-svg"
					role="img"
					aria-label="Chart"
					onPointerMove={pick}
					onPointerLeave={() => setHover(null)}
				>
					{yTicks.map((v) => (
						<g key={v}>
							<line
								class="chart-grid"
								x1={PAD.left}
								x2={W - PAD.right}
								y1={y(v)}
								y2={y(v)}
							/>
							<text
								class="chart-label"
								x={PAD.left - 6}
								y={y(v) + 4}
								text-anchor="end"
							>
								{formatY(v)}
							</text>
						</g>
					))}
					{tickIndices(n, 5).map((i) => (
						<text
							key={i}
							class="chart-label"
							x={x(i)}
							y={H - 6}
							text-anchor={
								i === 0 && n > 1
									? "start"
									: i === n - 1 && n > 1
										? "end"
										: "middle"
							}
						>
							{formatX(xs[i] as number)}
						</text>
					))}

					{kind === "bars"
						? xs.map((t, i) => {
								let base = 0;
								return (
									<g key={t}>
										{series.map((s) => {
											const v = s.values[i] ?? 0;
											const bottom = base;
											base += v;
											if (v <= 0) return null;
											return (
												<rect
													key={s.key}
													x={x(i) - barW / 2}
													width={barW}
													y={y(bottom + v)}
													height={Math.max(0.5, y(bottom) - y(bottom + v))}
													fill={s.color}
												/>
											);
										})}
									</g>
								);
							})
						: series.map((s) => {
								const pts = xs.map(
									(_, i) => [x(i), y(s.values[i] ?? 0)] as const,
								);
								let d = `M${pts[0]?.[0]} ${pts[0]?.[1]}`;
								for (let i = 1; i < pts.length; i++)
									d += ` H${pts[i]?.[0]} V${pts[i]?.[1]}`;
								if (n === 1) d += ` H${PAD.left + PLOT_W}`;
								return (
									<path
										key={s.key}
										d={d}
										fill="none"
										stroke={s.color}
										stroke-width="2"
										stroke-linejoin="round"
									/>
								);
							})}

					{hover !== null && (
						<line
							class="chart-cursor"
							x1={x(hover)}
							x2={x(hover)}
							y1={PAD.top}
							y2={PAD.top + PLOT_H}
						/>
					)}
				</svg>
				{hover !== null && (
					<div
						class="chart-tip"
						style={
							x(hover) / W > 0.6
								? { right: `calc(${100 - (x(hover) / W) * 100}% + 10px)` }
								: { left: `calc(${(x(hover) / W) * 100}% + 10px)` }
						}
					>
						<div class="tip-title">
							{(props.formatTip ?? formatX)(xs[hover] as number)}
						</div>
						{series.map((s) => (
							<div key={s.key} class="chart-tip-row">
								<span class="chart-swatch" style={{ background: s.color }} />
								<span>{s.label}</span>
								<span class="chart-tip-value">
									{formatY(s.values[hover] ?? 0)}
								</span>
							</div>
						))}
						{hoverNote && <div class="muted hint">{hoverNote}</div>}
					</div>
				)}
			</div>
			<div class="chart-legend">
				{series.map((s) => (
					<span key={s.key}>
						<span class="chart-swatch" style={{ background: s.color }} />
						{s.label}
					</span>
				))}
			</div>
		</div>
	);
}

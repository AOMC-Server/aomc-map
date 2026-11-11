import { STATS_RANGES, type StatsRange } from "@aomc/shared";
import type { InferResponseType } from "hono/client";
import { useEffect, useState } from "preact/hooks";
import { api, attempt, loginUrl } from "../api";
import { loadUser } from "../controller";
import { user } from "../state";
import { Chart } from "./Chart";
import { Page } from "./Page";
import { RangePicker } from "./RangePicker";

type StatsBody = InferResponseType<typeof api.api.stats.$get, 200>;
type UserStats = NonNullable<StatsBody["me"]>;
type Row = StatsBody["leaderboard"][number];

const RANGE_NAMES: Record<StatsRange, string> = {
	all: "All time",
	"30d": "30 days",
	"7d": "7 days",
};

type Column = {
	key:
		| "uploads"
		| "tiles"
		| "areaTiles"
		| "featuresCreated"
		| "featureEdits"
		| "layersCreated";
	label: string;
	hint: string;
};

const COLUMNS: Column[] = [
	{ key: "uploads", label: "Uploads", hint: "Finished uploads" },
	{
		key: "tiles",
		label: "Tiles",
		hint: "Map tiles uploaded, counting repeats",
	},
	{ key: "areaTiles", label: "Area", hint: "Distinct ground uploaded" },
	{
		key: "featuresCreated",
		label: "Features",
		hint: "Pins, lines and areas created",
	},
	{
		key: "featureEdits",
		label: "Edits",
		hint: "Changes to features after they were made",
	},
	{ key: "layersCreated", label: "Layers", hint: "Layers created" },
];

const number = (n: number) => n.toLocaleString();

/** Square blocks, in km² once it gets large (a block is a metre). */
function formatArea(blocks: number): string {
	if (blocks >= 1_000_000)
		return `${(blocks / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
	return `${number(blocks)} blocks²`;
}

function cell(s: UserStats, key: Column["key"]): string {
	return key === "areaTiles" ? formatArea(s.areaBlocks) : number(s[key]);
}

function readRange(): StatsRange {
	const r = new URLSearchParams(location.search).get("range");
	return (STATS_RANGES as readonly string[]).includes(r ?? "")
		? (r as StatsRange)
		: "all";
}

function StatTiles(props: { stats: UserStats }) {
	const s = props.stats;
	const byType = s.featuresByType;
	const tiles: { label: string; value: string; hint?: string }[] = [
		{ label: "Uploads", value: number(s.uploads) },
		{ label: "Tiles uploaded", value: number(s.tiles) },
		{
			label: "Area uploaded",
			value: formatArea(s.uploadedBlocks),
			hint: "Total volume, counting ground that was uploaded again",
		},
		{
			label: "Area mapped",
			value: formatArea(s.areaBlocks),
			hint: `${number(s.areaTiles)} distinct tiles`,
		},
		{
			label: "Features created",
			value: number(s.featuresCreated),
			hint: `${number(byType.pin)} pins · ${number(byType.line)} lines · ${number(byType.polygon)} areas`,
		},
		{ label: "Feature edits", value: number(s.featureEdits) },
		{ label: "Layers created", value: number(s.layersCreated) },
	];
	return (
		<div class="stats-grid">
			{tiles.map((t) => (
				<div key={t.label} class="stats-tile">
					<div class="label">{t.label}</div>
					<div class="stats-value">{t.value}</div>
					{t.hint && <div class="muted hint">{t.hint}</div>}
				</div>
			))}
		</div>
	);
}

const DAY = 24 * 3600_000;

function AreaChart(props: { data: StatsBody; signedIn: boolean }) {
	const { areaHistory: points, since } = props.data;
	const mine = props.signedIn && props.data.me !== null;
	const xs = points.map((p) => p.t);
	const short = since !== null && Date.now() - since <= 7 * DAY;
	return (
		<Chart
			kind="steps"
			xs={xs}
			series={[
				{
					key: "map",
					label: "Whole map",
					color: "var(--chart-1)",
					values: points.map((p) => p.totalBlocks),
				},
				...(mine
					? [
							{
								key: "me",
								label: "You",
								color: "var(--chart-2)",
								values: points.map((p) => p.myBlocks ?? 0),
							},
						]
					: []),
			]}
			formatY={formatArea}
			formatX={(t) =>
				new Date(t).toLocaleString(
					undefined,
					short
						? { month: "short", day: "numeric", hour: "numeric" }
						: { month: "short", day: "numeric" },
				)
			}
		/>
	);
}

function Leaderboard(props: { rows: Row[]; me: string | null }) {
	const [sort, setSort] = useState<Column["key"]>("tiles");
	const rows = [...props.rows].sort(
		(a, b) =>
			b[sort] - a[sort] ||
			b.tiles - a.tiles ||
			a.username.localeCompare(b.username),
	);
	if (rows.length === 0)
		return <p class="muted">Nobody has contributed in this period.</p>;
	return (
		<div class="stats-table-wrap">
			<table class="stats-table">
				<thead>
					<tr>
						<th class="stats-rank">#</th>
						<th>Player</th>
						{COLUMNS.map((c) => (
							<th
								key={c.key}
								class="stats-num"
								aria-sort={c.key === sort ? "descending" : undefined}
							>
								<button
									type="button"
									class={`stats-sort ${c.key === sort ? "active" : ""}`}
									title={c.hint}
									onClick={() => setSort(c.key)}
								>
									{c.label}
									{c.key === sort ? " ▼" : ""}
								</button>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((r, i) => (
						<tr key={r.userId} class={r.userId === props.me ? "stats-me" : ""}>
							<td class="stats-rank">{i + 1}</td>
							<td>
								<span class="stats-player">
									{r.avatarUrl ? (
										<img
											class="avatar"
											src={r.avatarUrl}
											alt=""
											width={24}
											height={24}
										/>
									) : (
										<span class="avatar placeholder" />
									)}
									{r.username}
								</span>
							</td>
							{COLUMNS.map((c) => (
								<td key={c.key} class="stats-num">
									{cell(r, c.key)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** /stats: your contributions and a leaderboard of everyone's. */
export function StatsPage() {
	const [range, setRange] = useState<StatsRange>(readRange);
	const [data, setData] = useState<StatsBody | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void loadUser();
	}, []);

	useEffect(() => {
		const url = new URL(location.href);
		if (range === "all") url.searchParams.delete("range");
		else url.searchParams.set("range", range);
		history.replaceState(null, "", url);

		let stale = false;
		void attempt(() => api.api.stats.$get({ query: { range } })).then((r) => {
			if (stale) return;
			if (r.ok) {
				setData(r.body);
				setError(null);
			} else setError(r.error);
		});
		return () => {
			stale = true;
		};
	}, [range]);

	const u = user.value;
	return (
		<Page title="Statistics">
			<RangePicker
				value={range}
				options={STATS_RANGES}
				names={RANGE_NAMES}
				onChange={setRange}
			/>
			{error && <p class="muted">Could not load the statistics: {error}</p>}

			<section class="page-section">
				<h2>Your stats</h2>
				{!data ? (
					<p class="muted">Loading…</p>
				) : data.me && u ? (
					<>
						<div class="account-card stats-account">
							{u.avatarUrl && (
								<img
									class="avatar"
									src={u.avatarUrl}
									alt=""
									width={40}
									height={40}
								/>
							)}
							<div>{u.username}</div>
						</div>
						<StatTiles stats={data.me} />
						<p class="muted hint">Includes your private layers.</p>
					</>
				) : (
					<>
						<p class="muted">Log in to see your own contributions.</p>
						<a class="btn primary" href={loginUrl()}>
							Log in with Discord
						</a>
					</>
				)}
			</section>

			<section class="page-section">
				<h2>Global stats</h2>
				{data ? (
					<>
						<StatTiles stats={data.totals} />
						<p class="muted hint">
							Everyone's contributions combined. Private layers are not counted.
						</p>
					</>
				) : (
					<p class="muted">Loading…</p>
				)}
			</section>

			<section class="page-section">
				<h2>Mapped area</h2>
				<p class="muted">
					Distinct ground uploaded, dated by when the uploaded data was exported
					(or by the upload, when that isn't known). Deleted uploads are not
					included.
				</p>
				{data ? (
					<AreaChart data={data} signedIn={u !== null} />
				) : (
					<p class="muted">Loading…</p>
				)}
			</section>

			<section class="page-section">
				<h2>Leaderboard</h2>
				{data ? (
					<Leaderboard rows={data.leaderboard} me={u?.id ?? null} />
				) : (
					<p class="muted">Loading…</p>
				)}
			</section>
		</Page>
	);
}

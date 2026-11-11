import { STATS_RANGES, type StatsRange } from "@aomc/shared";
import type { InferResponseType } from "hono/client";
import { useEffect, useState } from "preact/hooks";
import { api, loginUrl } from "../api";
import { loadUser } from "../controller";
import { user } from "../state";
import { DAY } from "../time";
import { Chart } from "./Chart";
import { Page } from "./Page";
import { RangePicker } from "./RangePicker";
import { number, SortHeader, TileGrid, useStats } from "./statsCommon";

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
		| "modUploads"
		| "modAreaTiles"
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
		key: "modUploads",
		label: "Webmapper uploads",
		hint: "Uploads sent by the AOMC Webmapper mod (also counted in Uploads)",
	},
	{
		key: "modAreaTiles",
		label: "Webmapper area",
		hint: "Distinct ground the AOMC Webmapper mod mapped (also counted in Area)",
	},
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

/** An area of square blocks in km² (a block is a metre). */
function formatArea(blocks: number): string {
	return `${(blocks / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
}

function cell(s: UserStats, key: Column["key"]): string {
	if (key === "areaTiles") return formatArea(s.areaBlocks);
	if (key === "modAreaTiles") return formatArea(s.modAreaBlocks);
	return number(s[key]);
}

function readRange(): StatsRange {
	const r = new URLSearchParams(location.search).get("range");
	return (STATS_RANGES as readonly string[]).includes(r ?? "")
		? (r as StatsRange)
		: "all";
}

type StatTab = "me" | "global";

const STAT_TABS: { id: StatTab; label: string }[] = [
	{ id: "me", label: "Your stats" },
	{ id: "global", label: "Global stats" },
];

/**
 * The contributions, then the part of them sent by the AOMC Webmapper mod. `note` is about the
 * contributions (the mod cannot touch layers), so it goes between the two.
 */
function StatTiles(props: { stats: UserStats; note: string }) {
	const s = props.stats;
	const byType = s.featuresByType;
	return (
		<>
			<TileGrid
				tiles={[
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
				]}
			/>
			<p class="muted hint">{props.note}</p>
			<h3 class="stats-group">AOMC Webmapper</h3>
			<p class="muted hint">
				The part of the above that was sent by the in-game mod.
			</p>
			<TileGrid
				tiles={[
					{ label: "AOMC Webmapper uploads", value: number(s.modUploads) },
					{
						label: "Area uploaded by AOMC Webmapper",
						value: formatArea(s.modUploadedBlocks),
						hint: "Total volume, counting ground that was uploaded again",
					},
					{
						label: "Area mapped by AOMC Webmapper",
						value: formatArea(s.modAreaBlocks),
						hint: `${number(s.modAreaTiles)} distinct tiles`,
					},
				]}
			/>
		</>
	);
}

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
						: { year: "numeric", month: "short", day: "numeric" },
				)
			}
			formatTip={(t) =>
				new Date(t).toLocaleString(
					undefined,
					short
						? {
								year: "numeric",
								month: "short",
								day: "numeric",
								hour: "numeric",
							}
						: { year: "numeric", month: "short", day: "numeric" },
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
							<SortHeader key={c.key} column={c} sort={sort} onSort={setSort} />
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
	const [picked, setPicked] = useState<StatTab | null>(null);

	useEffect(() => {
		void loadUser();
	}, []);

	useEffect(() => {
		const url = new URL(location.href);
		if (range === "all") url.searchParams.delete("range");
		else url.searchParams.set("range", range);
		history.replaceState(null, "", url);
	}, [range]);

	const { data, error } = useStats(
		() => api.api.stats.$get({ query: { range } }),
		[range],
	);

	const u = user.value;
	// Until one is picked, show your own stats when logged in and the global ones otherwise.
	const tab: StatTab = picked ?? (data && !data.me ? "global" : "me");
	return (
		<Page title="Statistics">
			<RangePicker
				value={range}
				options={STATS_RANGES}
				names={RANGE_NAMES}
				onChange={setRange}
			/>
			{error && <p class="muted">Could not load the statistics: {error}</p>}

			<div class="tabs tabbar" role="tablist">
				{STAT_TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						role="tab"
						aria-selected={t.id === tab}
						class={`plain tab ${t.id === tab ? "active" : ""}`}
						onClick={() => setPicked(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>

			<section class="page-section">
				<h2>{tab === "me" ? "Your stats" : "Global stats"}</h2>
				{!data ? (
					<p class="muted">Loading…</p>
				) : tab === "global" ? (
					<StatTiles
						stats={data.totals}
						note="Everyone's contributions combined. Private layers are not counted."
					/>
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
						<StatTiles stats={data.me} note="Includes your private layers." />
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

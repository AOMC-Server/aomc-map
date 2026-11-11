import { ADMIN_STATS_RANGES, type AdminStatsRange } from "@aomc/shared";
import type { InferResponseType } from "hono/client";
import { useState } from "preact/hooks";
import { api } from "../api";
import { DAY, HOUR } from "../time";
import { Chart, type ChartSeries } from "./Chart";
import { formatBytes, formatDay, formatDuration, formatTime } from "./format";
import { RangePicker } from "./RangePicker";
import { number, SortHeader, TileGrid, useStats } from "./statsCommon";

type Body = InferResponseType<typeof api.api.admin.stats.$get, 200>;
type Category = keyof Body["traffic"]["range"]["byCategory"];
type Domain = Body["traffic"]["domains"][number];

const RANGE_NAMES: Record<AdminStatsRange, string> = {
	"1h": "Last hour",
	"6h": "Last 6 hours",
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
	"90d": "90 days",
	all: "All time",
};

const CATEGORIES: { key: Category; label: string; color: string }[] = [
	{ key: "tiles", label: "Tile lookups", color: "var(--chart-1)" },
	{ key: "blobs", label: "Tile images", color: "var(--chart-2)" },
	{ key: "preview", label: "Link previews", color: "var(--chart-3)" },
	{ key: "api", label: "API", color: "var(--chart-4)" },
	{ key: "static", label: "Web app", color: "var(--chart-5)" },
	{ key: "auth", label: "Login", color: "var(--chart-6)" },
];

const STORAGE_NOTES: Record<string, string> = {
	upload: "After an upload",
	erase: "After an upload was deleted",
	gc: "After removing unused images",
	boot: "Server started",
};

const formatTimeOfDay = (t: number) =>
	new Date(t).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
const formatDayTime = (t: number) =>
	new Date(t).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
function Storage(props: { data: Body }) {
	const { storage, now, since, overview } = props.data;
	const cur = storage.current;
	const reclaimable = cur.blobBytes - cur.referencedBytes;

	const history = storage.history;
	const readings = [...history, cur];
	const xs = [...history.map((h) => Math.max(h.at, since ?? 0)), now];
	const series: ChartSeries[] = [
		{
			key: "all",
			label: "Tile images",
			color: "var(--chart-1)",
			values: readings.map((r) => r.blobBytes),
		},
		{
			key: "used",
			label: "Used by the map",
			color: "var(--chart-2)",
			values: readings.map((r) => r.referencedBytes),
		},
		{
			key: "db",
			label: "Database",
			color: "var(--chart-3)",
			values: readings.map((r) => r.dbBytes),
		},
	];
	const spanMs = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);
	const formatX =
		spanMs > 3 * DAY
			? formatDay
			: spanMs <= 6 * HOUR
				? formatTimeOfDay
				: formatDayTime;

	return (
		<>
			<h2>Storage</h2>
			<p class="muted">
				Summed from the recorded size of every image, not measured on disk. A
				point is added after each upload, deletion and cleanup.
			</p>
			<TileGrid
				tiles={[
					{
						label: "Tile images",
						value: formatBytes(cur.blobBytes),
						hint: `${number(cur.blobCount)} images, ${formatBytes(overview.tiles.averageImageBytes)} each on average`,
					},
					{
						label: "Used by the map",
						value: formatBytes(cur.referencedBytes),
						hint: `${number(cur.referencedBlobs)} images, each used ${overview.tiles.reuse}× on average`,
					},
					{
						label: "Waiting for cleanup",
						value: formatBytes(reclaimable),
						hint: "Unused images that scripts/gc-blobs.ts removes",
					},
					{ label: "Database", value: formatBytes(cur.dbBytes) },
				]}
			/>
			<div class="admin-block">
				<Chart
					kind="steps"
					xs={xs}
					series={series}
					formatY={formatBytes}
					formatX={formatX}
					formatTip={formatTime}
					note={(i) =>
						i === xs.length - 1
							? "Now"
							: (STORAGE_NOTES[history[i]?.reason ?? ""] ?? null)
					}
				/>
			</div>
		</>
	);
}

function Traffic(props: { data: Body }) {
	const { traffic } = props.data;
	const [metric, setMetric] = useState<"bytes" | "requests">("bytes");

	const series: ChartSeries[] = CATEGORIES.map((c) => ({
		key: c.key,
		label: c.label,
		color: c.color,
		values: traffic.points.map((p) => p[metric][c.key]),
	})).filter((s) => s.values.some((v) => v > 0));

	const range = traffic.range;
	const errors = range.total.s4xx;
	return (
		<>
			<div class="admin-toolbar">
				<h2>Network traffic</h2>
				<div class="segmented">
					{(["bytes", "requests"] as const).map((m) => (
						<button
							key={m}
							type="button"
							class={`btn small ${m === metric ? "active" : ""}`}
							aria-pressed={m === metric}
							onClick={() => setMetric(m)}
						>
							{m === "bytes" ? "Data sent" : "Requests"}
						</button>
					))}
				</div>
			</div>
			<p class="muted">
				What this server sent, counted as it happens. Redirects and errors carry
				almost no data.
			</p>
			<TileGrid
				tiles={[
					{
						label: "Sent in this period",
						value: formatBytes(range.total.bytes),
						hint: `${formatBytes(traffic.allTime.total.bytes)} in total`,
					},
					{
						label: "Requests in this period",
						value: number(range.total.requests),
						hint: `${number(traffic.allTime.total.requests)} in total`,
					},
					{
						label: "Failed requests",
						value: number(errors),
						hint:
							range.total.requests > 0
								? `${((errors / range.total.requests) * 100).toFixed(1)}% of requests`
								: undefined,
					},
				]}
			/>
			<div class="admin-block">
				<Chart
					kind="bars"
					xs={traffic.points.map((p) => p.t)}
					series={series}
					formatY={metric === "bytes" ? formatBytes : number}
					formatTip={traffic.bucketMs < DAY ? formatTime : formatDay}
					formatX={
						traffic.bucketMs < HOUR
							? formatTimeOfDay
							: traffic.bucketMs < DAY
								? formatDayTime
								: formatDay
					}
				/>
			</div>
			<div class="stats-table-wrap">
				<table class="stats-table">
					<thead>
						<tr>
							<th>Kind</th>
							<th class="stats-num">Requests</th>
							<th class="stats-num">Sent</th>
							<th class="stats-num">Redirects</th>
							<th class="stats-num">Errors</th>
							<th class="stats-num">Sent, all time</th>
						</tr>
					</thead>
					<tbody>
						{CATEGORIES.map((c) => {
							const r = range.byCategory[c.key];
							return (
								<tr key={c.key}>
									<td>
										<span
											class="chart-swatch"
											style={{ background: c.color }}
										/>
										{c.label}
									</td>
									<td class="stats-num">{number(r.requests)}</td>
									<td class="stats-num">{formatBytes(r.bytes)}</td>
									<td class="stats-num">{number(r.s3xx)}</td>
									<td class="stats-num">{number(r.s4xx)}</td>
									<td class="stats-num">
										{formatBytes(traffic.allTime.byCategory[c.key].bytes)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</>
	);
}

type DomainSort = "bytes" | "tileRequests" | "blobRequests" | "lastSeen";

const DOMAIN_COLUMNS: { key: DomainSort; label: string; hint: string }[] = [
	{ key: "tileRequests", label: "Tile lookups", hint: "Requests for a tile" },
	{ key: "blobRequests", label: "Images", hint: "Tile images downloaded" },
	{ key: "bytes", label: "Sent", hint: "Data sent for tiles and images" },
	{ key: "lastSeen", label: "Last seen", hint: "Most recent request" },
];

const PSEUDO_DOMAINS = new Set(["This site", "No referrer", "Other"]);

function Domains(props: { data: Body }) {
	const [sort, setSort] = useState<DomainSort>("bytes");
	const rows: Domain[] = [...props.data.traffic.domains].sort(
		(a, b) => b[sort] - a[sort] || a.domain.localeCompare(b.domain),
	);
	const total = rows.reduce((n, d) => n + d.bytes, 0);
	return (
		<>
			<h2>Where tiles are requested from</h2>
			<p class="muted">
				The site named in the Origin or Referer of each request. “No referrer”
				is scripts and direct downloads, which send neither.
			</p>
			{rows.length === 0 ? (
				<p class="muted">No tile requests in this period.</p>
			) : (
				<div class="stats-table-wrap">
					<table class="stats-table">
						<thead>
							<tr>
								<th>Domain</th>
								{DOMAIN_COLUMNS.map((c) => (
									<SortHeader
										key={c.key}
										column={c}
										sort={sort}
										onSort={setSort}
									/>
								))}
								<th>Share of data</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((d) => {
								const share = total > 0 ? d.bytes / total : 0;
								return (
									<tr key={d.domain}>
										<td
											class={PSEUDO_DOMAINS.has(d.domain) ? "muted-cell" : ""}
										>
											{d.domain}
										</td>
										<td class="stats-num">{number(d.tileRequests)}</td>
										<td class="stats-num">{number(d.blobRequests)}</td>
										<td class="stats-num">{formatBytes(d.bytes)}</td>
										<td class="stats-num">{formatTime(d.lastSeen)}</td>
										<td>
											<span class="share-bar" aria-hidden="true">
												<span
													class="share-fill"
													style={{ width: `${share * 100}%` }}
												/>
											</span>{" "}
											{(share * 100).toFixed(1)}%
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</>
	);
}

function Overview(props: { data: Body }) {
	const o = props.data.overview;
	return (
		<>
			<h2>Server</h2>
			<TileGrid
				tiles={[
					{
						label: "Users",
						value: number(o.users.total),
						hint: `${number(o.users.active7d)} logged in this week, ${number(o.users.active30d)} this month`,
					},
					{
						label: "Sessions / API tokens",
						value: `${number(o.users.sessions)} / ${number(o.users.tokens)}`,
						hint: `${number(o.users.tokensUsed30d)} tokens used in the last 30 days`,
					},
					{
						label: "Uploads",
						value: number(o.map.uploadsDone),
						hint: `${number(o.map.uploadsViaMod)} via the mod, ${number(o.map.uploadsFailed)} failed`,
					},
					{
						label: "Layers",
						value: number(o.map.publicLayers + o.map.privateLayers),
						hint: `${number(o.map.privateLayers)} private, in ${number(o.map.dimensions)} dimensions`,
					},
					{
						label: "Features",
						value: number(o.map.features),
						hint: `${number(o.map.featureRevisions)} versions kept`,
					},
					{
						label: "Tile versions",
						value: number(o.tiles.tileVersions),
						hint: `${number(o.tiles.references)} image references`,
					},
					{
						label: "Job queue",
						value: `${number(o.jobs.pending + o.jobs.processing)} waiting`,
						hint: `${number(o.jobs.failed)} failed`,
					},
					{
						label: "Uptime",
						value: formatDuration(o.process.uptimeSeconds),
						hint: `${formatBytes(o.process.rssBytes)} memory, Bun ${o.process.bun}`,
					},
				]}
			/>
		</>
	);
}

/** The owners' view of storage, network traffic and the server. */
export function AdminStats() {
	const [range, setRange] = useState<AdminStatsRange>("7d");
	const { data, error } = useStats(
		() => api.api.admin.stats.$get({ query: { range } }),
		[range],
	);

	return (
		<div class="admin-stats">
			<RangePicker
				value={range}
				options={ADMIN_STATS_RANGES}
				names={RANGE_NAMES}
				onChange={setRange}
			/>
			{error && (
				<p class="error-text">Could not load the statistics: {error}</p>
			)}
			{!data ? (
				!error && <p class="muted">Loading…</p>
			) : (
				<>
					<Storage data={data} />
					<Traffic data={data} />
					<Domains data={data} />
					<Overview data={data} />
				</>
			)}
		</div>
	);
}

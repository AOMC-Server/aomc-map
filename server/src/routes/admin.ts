import {
	type AdminStatsRange,
	adminStatsQuerySchema,
	DAY,
	FIVE_MINUTES,
	HOUR,
	MINUTE,
} from "@aomc/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { Db } from "../db/client";
import { lateUploads, queueRecompute } from "../jobs/recomputeHistory";
import { doc } from "../openapi";
import { canManage } from "../permissions";
import { measureStorage } from "../storage";
import { recomputeSnapshot } from "../topics";
import { TRAFFIC_CATEGORIES, type TrafficCategory } from "../traffic";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const RANGE_MS: Record<AdminStatsRange, number | null> = {
	"1h": HOUR,
	"6h": 6 * HOUR,
	"24h": DAY,
	"7d": 7 * DAY,
	"30d": 30 * DAY,
	"90d": 90 * DAY,
	all: null,
};
const MAX_STORAGE_POINTS = 300;

type Counts = {
	requests: number;
	bytes: number;
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
};
const emptyCounts = (): Counts => ({
	requests: 0,
	bytes: 0,
	s2xx: 0,
	s3xx: 0,
	s4xx: 0,
	s5xx: 0,
});

const one = <T>(db: Db, query: ReturnType<typeof sql>) =>
	db.all<T>(query)[0] as T;

const HISTORY_COLUMNS = sql`at, reason, blob_count AS blobCount, blob_bytes AS blobBytes,
	referenced_blobs AS referencedBlobs, referenced_bytes AS referencedBytes, db_bytes AS dbBytes`;

type HistoryRow = {
	at: number;
	reason: string;
	blobCount: number;
	blobBytes: number;
	referencedBlobs: number;
	referencedBytes: number;
	dbBytes: number;
};

/** The readings in the range, thinned for long ranges, led by the last one before it so the curve has a start. */
function storageHistory(db: Db, since: number) {
	const rows = db.all<HistoryRow>(
		sql`SELECT ${HISTORY_COLUMNS} FROM storage_history WHERE at >= ${since} ORDER BY at, id`,
	);
	let out = rows;
	if (rows.length > MAX_STORAGE_POINTS) {
		const step = rows.length / MAX_STORAGE_POINTS;
		out = Array.from(
			{ length: MAX_STORAGE_POINTS },
			(_, i) => rows[Math.floor(i * step)] as HistoryRow,
		);
		out.push(rows[rows.length - 1] as HistoryRow);
	}
	const [before] = db.all<HistoryRow>(
		sql`SELECT ${HISTORY_COLUMNS} FROM storage_history WHERE at < ${since} ORDER BY at DESC, id DESC LIMIT 1`,
	);
	return before ? [before, ...out] : out;
}

/** The length of one bar, chosen so a chart has a few dozen to about a hundred. */
function bucketFor(span: number): number {
	if (span <= HOUR) return MINUTE;
	if (span <= 6 * HOUR) return FIVE_MINUTES;
	if (span <= DAY) return HOUR;
	if (span <= 7 * DAY) return 3 * HOUR;
	return DAY;
}

function trafficSeries(db: Db, since: number, now: number) {
	const bucket = bucketFor(now - since);
	const rows = db.all<{
		t: number;
		category: TrafficCategory;
		requests: number;
		bytes: number;
	}>(sql`
		SELECT (hour / ${bucket}) * ${bucket} AS t, category, SUM(requests) AS requests, SUM(bytes) AS bytes
		FROM traffic_hourly WHERE hour >= ${since} GROUP BY 1, 2`);
	const points = new Map<
		number,
		{
			t: number;
			bytes: Record<TrafficCategory, number>;
			requests: Record<TrafficCategory, number>;
		}
	>();
	const blank = () =>
		Object.fromEntries(TRAFFIC_CATEGORIES.map((c) => [c, 0])) as Record<
			TrafficCategory,
			number
		>;
	// "All time" starts at the first recorded data rather than at 1970.
	const start =
		since > 0
			? Math.floor(since / bucket) * bucket
			: rows.length > 0
				? Math.min(...rows.map((r) => r.t))
				: Math.floor(now / bucket) * bucket;
	for (let t = start; t <= now; t += bucket)
		points.set(t, { t, bytes: blank(), requests: blank() });
	for (const r of rows) {
		const p = points.get(r.t);
		if (!p) continue;
		p.bytes[r.category] = r.bytes;
		p.requests[r.category] = r.requests;
	}
	return { bucketMs: bucket, points: [...points.values()] };
}

function trafficTotals(db: Db, since: number) {
	const rows = db.all<Counts & { category: TrafficCategory }>(sql`
		SELECT category, SUM(requests) AS requests, SUM(bytes) AS bytes, SUM(s2xx) AS s2xx,
			SUM(s3xx) AS s3xx, SUM(s4xx) AS s4xx, SUM(s5xx) AS s5xx
		FROM traffic_hourly WHERE hour >= ${since} GROUP BY category`);
	const byCategory = Object.fromEntries(
		TRAFFIC_CATEGORIES.map((c) => [c, emptyCounts()]),
	) as Record<TrafficCategory, Counts>;
	const total = emptyCounts();
	for (const { category, ...counts } of rows) {
		byCategory[category] = counts;
		for (const k of Object.keys(total) as (keyof Counts)[])
			total[k] += counts[k];
	}
	return { total, byCategory };
}

function domainBreakdown(db: Db, since: number) {
	return db.all<{
		domain: string;
		tileRequests: number;
		blobRequests: number;
		bytes: number;
		firstSeen: number;
		lastSeen: number;
	}>(sql`
		SELECT domain,
			SUM(CASE WHEN category = 'tiles' THEN requests ELSE 0 END) AS tileRequests,
			SUM(CASE WHEN category = 'blobs' THEN requests ELSE 0 END) AS blobRequests,
			SUM(bytes) AS bytes, MIN(hour) AS firstSeen, MAX(hour) AS lastSeen
		FROM traffic_hourly WHERE category IN ('tiles', 'blobs') AND hour >= ${since}
		GROUP BY domain ORDER BY bytes DESC, tileRequests DESC`);
}

function overview(db: Db, now: number) {
	const n = (q: ReturnType<typeof sql>) => one<{ n: number }>(db, q).n;
	const storage = measureStorage(db);
	const refs = n(
		sql`SELECT (SELECT COUNT(*) FROM tile_versions WHERE blob_hash IS NOT NULL) + (SELECT COUNT(*) FROM upload_patches) AS n`,
	);
	const jobs = db.all<{ status: string; n: number }>(
		sql`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`,
	);
	const job = (s: string) => jobs.find((j) => j.status === s)?.n ?? 0;
	const mem = process.memoryUsage();
	return {
		users: {
			total: n(sql`SELECT COUNT(*) AS n FROM users`),
			active7d: n(
				sql`SELECT COUNT(*) AS n FROM users WHERE last_login_at >= ${now - 7 * DAY}`,
			),
			active30d: n(
				sql`SELECT COUNT(*) AS n FROM users WHERE last_login_at >= ${now - 30 * DAY}`,
			),
			sessions: n(
				sql`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ${now}`,
			),
			tokens: n(sql`SELECT COUNT(*) AS n FROM api_tokens`),
			tokensUsed30d: n(
				sql`SELECT COUNT(*) AS n FROM api_tokens WHERE last_used_at >= ${now - 30 * DAY}`,
			),
		},
		map: {
			dimensions: n(
				sql`SELECT COUNT(*) AS n FROM dimensions WHERE archived = 0`,
			),
			publicLayers: n(
				sql`SELECT COUNT(*) AS n FROM layers WHERE deleted_at IS NULL AND visibility = 'public'`,
			),
			privateLayers: n(
				sql`SELECT COUNT(*) AS n FROM layers WHERE deleted_at IS NULL AND visibility = 'private'`,
			),
			features: n(sql`SELECT COUNT(*) AS n FROM features`),
			featureRevisions: n(sql`SELECT COUNT(*) AS n FROM feature_revisions`),
			uploadsDone: n(
				sql`SELECT COUNT(*) AS n FROM revisions WHERE kind = 'upload' AND status = 'done'`,
			),
			uploadsViaMod: n(
				sql`SELECT COUNT(*) AS n FROM revisions WHERE kind = 'upload' AND status = 'done' AND via_mod = 1`,
			),
			uploadsFailed: n(
				sql`SELECT COUNT(*) AS n FROM revisions WHERE kind = 'upload' AND status = 'failed'`,
			),
		},
		tiles: {
			tileVersions: n(sql`SELECT COUNT(*) AS n FROM tile_versions`),
			references: refs,
			images: storage.blobCount,
			averageImageBytes:
				storage.blobCount > 0
					? Math.round(storage.blobBytes / storage.blobCount)
					: 0,
			/** How many times an average referenced image is used. */
			reuse:
				storage.referencedBlobs > 0
					? Math.round((refs / storage.referencedBlobs) * 100) / 100
					: 0,
		},
		jobs: {
			pending: job("pending"),
			processing: job("processing"),
			failed: job("failed"),
		},
		process: {
			uptimeSeconds: Math.round(process.uptime()),
			rssBytes: mem.rss,
			heapBytes: mem.heapUsed,
			bun: Bun.version,
		},
	};
}

export const adminRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get(
		"/stats",
		doc({
			tag: "Admin",
			summary: "Storage, traffic and server statistics",
			description:
				"Owners. Storage is summed from recorded image sizes. Traffic counts what this server sent, grouped by the domain that requested tiles and images. `range` is `1h` (per-minute detail), `6h` (5-minute detail), `24h`, `7d` (default), `30d`, `90d` or `all`.",
			fails: [400, 403],
			login: true,
		}),
		validate("query", adminStatsQuerySchema),
		(c) => {
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const { db, svc } = c.var;
			const { range } = c.req.valid("query");
			const now = Date.now();
			const span = RANGE_MS[range];
			const since = span === null ? 0 : now - span;
			svc.traffic.flush(now);

			return c.json({
				range,
				since: span === null ? null : since,
				now,
				storage: {
					current: measureStorage(db),
					history: storageHistory(db, since),
				},
				traffic: {
					...trafficSeries(db, since, now),
					range: trafficTotals(db, since),
					allTime: trafficTotals(db, 0),
					domains: domainBreakdown(db, since),
				},
				overview: overview(db, now),
			});
		},
	)
	.get(
		"/history",
		doc({
			tag: "Admin",
			summary: "How the map's history is ordered",
			description:
				"Owners. `lateUploads` counts finished uploads published after an upload of the same dimension that was exported later; looking at the map as of one of them also shows those newer exports. `recompute` is the newest history recompute (null if there never was one): its `status`, `error` when it failed, and while it runs, `progress` (`message`, and `done` of `total` steps where known).",
			fails: [403],
			login: true,
		}),
		(c) => {
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const { db, svc } = c.var;
			return c.json({
				lateUploads: lateUploads(db),
				recompute: recomputeSnapshot(db, svc.worker.recomputeProgress())
					.recompute,
			});
		},
	)
	.post(
		"/history/recompute",
		doc({
			tag: "Admin",
			summary: "Recompute the history in export order",
			description:
				"Owners. Queues a job that renumbers every finished upload by export date (across all dimensions) and rebuilds every past revision of the map from that order, so the map as of an upload holds exactly the uploads exported up to then. The newest map stays the same. Revision numbers change, so links to a `rev` afterwards show a different moment. Follow it with `GET /api/admin/history`.",
			ok: { 202: "Queued" },
			fails: [403, 409],
			login: true,
		}),
		(c) => {
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const { db, svc } = c.var;
			if (!queueRecompute(db))
				return c.json(
					{ error: "a recompute is already queued or running" },
					409,
				);
			svc.events.emit(
				"recompute",
				recomputeSnapshot(db, svc.worker.recomputeProgress()),
			);
			svc.worker.kick();
			return c.json({ ok: true }, 202);
		},
	);

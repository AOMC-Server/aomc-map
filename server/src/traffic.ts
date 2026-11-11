import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Db } from "./db/client";
import { trafficHourly } from "./db/schema";
import type { Env } from "./env";
import type { AppEnv } from "./types";

export const MINUTE = 60_000;
export const FIVE_MINUTES = 5 * MINUTE;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Per-minute rows older than this are folded into one row per hour. */
export const MINUTE_RETENTION_HOURS = 24;
/** Hourly rows older than this are folded into one row per day. */
export const HOURLY_RETENTION_DAYS = 90;
const FLUSH_EVERY = 60_000;
const MAX_DOMAINS_PER_HOUR = 200;

export const SELF_DOMAIN = "This site";
export const NO_REFERRER = "No referrer";
export const OTHER_DOMAIN = "Other";

export type TrafficCategory = (typeof trafficHourly.$inferInsert)["category"];
export const TRAFFIC_CATEGORIES: TrafficCategory[] = [
	"tiles",
	"blobs",
	"preview",
	"api",
	"auth",
	"static",
];

export function categoryOf(path: string): TrafficCategory {
	if (path.startsWith("/blobs/")) return "blobs";
	if (/^\/api\/dimensions\/[^/]+\/tiles\//.test(path)) return "tiles";
	if (path === "/api/preview.png") return "preview";
	if (path.startsWith("/auth/")) return "auth";
	if (path.startsWith("/api/")) return "api";
	return "static";
}

/** Where a request for tile data came from: the host of its Origin or Referer. */
export function domainOf(
	origin: string | undefined,
	referer: string | undefined,
	selfHost: string,
): string {
	for (const value of [origin, referer]) {
		if (!value || value === "null") continue;
		try {
			const host = new URL(value).host.toLowerCase().slice(0, 100);
			if (host) return host === selfHost ? SELF_DOMAIN : host;
		} catch {}
	}
	return NO_REFERRER;
}

type Counter = {
	requests: number;
	bytes: number;
	s2xx: number;
	s3xx: number;
	s4xx: number;
};

/** Counts what the server sends in memory and writes it out in batches. */
export function createTraffic(db: Db, env: Env) {
	const selfHost = new URL(env.PUBLIC_URL).host.toLowerCase();
	let pending = new Map<
		string,
		{
			hour: number;
			category: TrafficCategory;
			domain: string;
		} & Counter
	>();
	const domainsByHour = new Map<number, Set<string>>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastFold = 0;

	function limitDomain(hour: number, domain: string): string {
		const seen = domainsByHour.get(hour) ?? new Set<string>();
		domainsByHour.set(hour, seen);
		if (seen.has(domain)) return domain;
		if (seen.size >= MAX_DOMAINS_PER_HOUR) return OTHER_DOMAIN;
		seen.add(domain);
		return domain;
	}

	function record(
		category: TrafficCategory,
		domain: string,
		bytes: number,
		status: number,
		now = Date.now(),
	) {
		const minute = Math.floor(now / MINUTE) * MINUTE;
		const hour = Math.floor(now / HOUR) * HOUR;
		for (const h of domainsByHour.keys()) if (h < hour) domainsByHour.delete(h);
		const d =
			category === "tiles" || category === "blobs"
				? limitDomain(hour, domain)
				: "";
		const key = `${minute}|${category}|${d}`;
		let row = pending.get(key);
		if (!row) {
			row = {
				hour: minute,
				category,
				domain: d,
				requests: 0,
				bytes: 0,
				s2xx: 0,
				s3xx: 0,
				s4xx: 0,
			};
			pending.set(key, row);
		}
		row.requests++;
		row.bytes += bytes;
		if (status < 300) row.s2xx++;
		else if (status < 400) row.s3xx++;
		else row.s4xx++;
	}

	/** Folds rows older than `cutoff` (a multiple of `unit`) into one row per `unit`. */
	function foldInto(unit: number, cutoff: number) {
		const old = db.all<{
			hour: number;
			category: TrafficCategory;
			domain: string;
			requests: number;
			bytes: number;
			s2xx: number;
			s3xx: number;
			s4xx: number;
		}>(sql`
			SELECT (hour / ${unit}) * ${unit} AS hour, category, domain, SUM(requests) AS requests,
				SUM(bytes) AS bytes, SUM(s2xx) AS s2xx, SUM(s3xx) AS s3xx, SUM(s4xx) AS s4xx
			FROM traffic_hourly WHERE hour < ${cutoff} AND hour % ${unit} <> 0
			GROUP BY 1, 2, 3`);
		if (old.length === 0) return;
		db.transaction((tx) => {
			tx.run(
				sql`DELETE FROM traffic_hourly WHERE hour < ${cutoff} AND hour % ${unit} <> 0`,
			);
			for (const row of old) upsert(tx, row);
		});
	}

	/** Per-minute rows become hourly after a day, and hourly rows daily after 90 days. */
	function fold(now = Date.now()) {
		foldInto(
			HOUR,
			Math.floor((now - MINUTE_RETENTION_HOURS * HOUR) / HOUR) * HOUR,
		);
		foldInto(DAY, Math.floor((now - HOURLY_RETENTION_DAYS * DAY) / DAY) * DAY);
	}

	function flush(now = Date.now()) {
		if (pending.size > 0) {
			const rows = [...pending.values()];
			pending = new Map();
			db.transaction((tx) => {
				for (const row of rows) upsert(tx, row);
			});
		}
		if (now - lastFold >= HOUR) {
			lastFold = now;
			fold(now);
		}
	}

	return {
		record,
		flush,
		/** Starts writing to the database every minute. */
		start() {
			timer = setInterval(() => {
				try {
					flush();
				} catch (err) {
					console.error("writing traffic statistics failed:", err);
				}
			}, FLUSH_EVERY);
			timer.unref?.();
		},
		stop() {
			clearInterval(timer);
			flush();
		},
		middleware: createMiddleware<AppEnv>(async (c, next) => {
			await next();
			record(
				categoryOf(c.req.path),
				domainOf(c.req.header("Origin"), c.req.header("Referer"), selfHost),
				c.req.method === "HEAD" ? 0 : await sizeOf(c.res),
				c.res.status,
			);
		}),
	};
}

/** Bytes of a response body. Streams of unknown length (progress events) count as 0. */
async function sizeOf(res: Response): Promise<number> {
	const length = res.headers.get("Content-Length");
	if (length !== null && Number.isFinite(Number(length))) return Number(length);
	const type = res.headers.get("Content-Type") ?? "";
	if (!res.body || type.startsWith("text/event-stream")) return 0;
	return (await res.clone().arrayBuffer()).byteLength;
}

type Writer = Pick<Db, "insert">;

function upsert(
	tx: Writer,
	row: { hour: number; category: TrafficCategory; domain: string } & Counter,
) {
	tx.insert(trafficHourly)
		.values(row)
		.onConflictDoUpdate({
			target: [
				trafficHourly.hour,
				trafficHourly.category,
				trafficHourly.domain,
			],
			set: {
				requests: sql`${trafficHourly.requests} + excluded.requests`,
				bytes: sql`${trafficHourly.bytes} + excluded.bytes`,
				s2xx: sql`${trafficHourly.s2xx} + excluded.s2xx`,
				s3xx: sql`${trafficHourly.s3xx} + excluded.s3xx`,
				s4xx: sql`${trafficHourly.s4xx} + excluded.s4xx`,
			},
		})
		.run();
}

export type Traffic = ReturnType<typeof createTraffic>;

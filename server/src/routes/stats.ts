import {
	DAY,
	FEATURE_TYPES,
	type FeatureType,
	HOUR,
	MINUTE,
	type StatsRange,
	statsQuerySchema,
} from "@aomc/shared";
import { inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { doc } from "../openapi";
import type { AppEnv } from "../types";
import { validate } from "../validate";

/** How long the figures that are the same for everyone are reused. */
const CACHE_MS = MINUTE;
const RANGE_DAYS: Record<StatsRange, number | null> = {
	all: null,
	"30d": 30,
	"7d": 7,
};

export type UserStats = {
	uploads: number;
	/** Of which sent by the in-game mod; with the volume and the distinct ground it uploaded. */
	modUploads: number;
	modUploadedBlocks: number;
	modAreaTiles: number;
	modAreaBlocks: number;
	tiles: number;
	/** Every tile uploaded, repeats included, as blocks². */
	uploadedBlocks: number;
	areaTiles: number;
	areaBlocks: number;
	featuresCreated: number;
	featuresByType: Record<FeatureType, number>;
	featureEdits: number;
	layersCreated: number;
};

const emptyStats = (): UserStats => ({
	uploads: 0,
	modUploads: 0,
	modUploadedBlocks: 0,
	modAreaTiles: 0,
	modAreaBlocks: 0,
	tiles: 0,
	uploadedBlocks: 0,
	areaTiles: 0,
	areaBlocks: 0,
	featuresCreated: 0,
	featuresByType: { pin: 0, line: 0, polygon: 0 },
	featureEdits: 0,
	layersCreated: 0,
});

type Scope = {
	since: number;
	tileSize: number;
	/** Only this user's activity. */
	userId?: string;
	/** Leave out features and layers that are private or deleted. */
	publicOnly: boolean;
};

/** Finished uploads (revision `r`) that still count. */
const DONE_UPLOAD = sql.raw("r.kind = 'upload' AND r.status = 'done'");

/** The uploads of `DONE_UPLOAD` that completed since `since`. */
const uploadedSince = (since: number) =>
	sql`${DONE_UPLOAD} AND COALESCE(r.completed_at, r.created_at) >= ${since}`;

const FIRST_REVISION = sql.raw(
	"(SELECT MIN(id) FROM feature_revisions WHERE feature_id = fr.feature_id)",
);

/** Joins a feature revision `fr` to its layer, keeping only live public layers. */
const publicFeature = (s: Scope) =>
	s.publicOnly
		? sql.raw(
				"JOIN features f ON f.id = fr.feature_id JOIN layers l ON l.id = f.layer_id AND l.visibility = 'public' AND l.deleted_at IS NULL",
			)
		: sql``;

const byUser = (column: string, s: Scope): SQL =>
	s.userId ? sql`AND ${sql.raw(column)} = ${s.userId}` : sql``;

/** Every user's stats over the scope, by user id. Users with no activity are absent. */
function collect(db: Db, s: Scope): Map<string, UserStats> {
	const out = new Map<string, UserStats>();
	const get = (id: string) => {
		const row = out.get(id) ?? emptyStats();
		out.set(id, row);
		return row;
	};

	const uploads = db.all<{
		userId: string;
		uploads: number;
		modUploads: number;
		modTiles: number;
		modArea: number;
		tiles: number;
		area: number;
	}>(sql`
		SELECT r.author_id AS userId, COUNT(DISTINCT r.id) AS uploads,
			COUNT(DISTINCT CASE WHEN r.via_mod = 1 THEN r.id END) AS modUploads,
			COUNT(CASE WHEN r.via_mod = 1 THEN p.revision_id END) AS modTiles,
			COUNT(DISTINCT CASE WHEN r.via_mod = 1 THEN r.dimension_id || ':' || p.tile_x || ':' || p.tile_y END) AS modArea,
			COUNT(p.revision_id) AS tiles,
			COUNT(DISTINCT r.dimension_id || ':' || p.tile_x || ':' || p.tile_y) AS area
		FROM revisions r LEFT JOIN upload_patches p ON p.revision_id = r.id
		WHERE ${uploadedSince(s.since)} ${byUser("r.author_id", s)}
		GROUP BY r.author_id`);
	for (const r of uploads) {
		const row = get(r.userId);
		row.uploads = r.uploads;
		row.modUploads = r.modUploads;
		row.modUploadedBlocks = r.modTiles * s.tileSize * s.tileSize;
		row.modAreaTiles = r.modArea;
		row.modAreaBlocks = r.modArea * s.tileSize * s.tileSize;
		row.tiles = r.tiles;
		row.uploadedBlocks = r.tiles * s.tileSize * s.tileSize;
		row.areaTiles = r.area;
		row.areaBlocks = r.area * s.tileSize * s.tileSize;
	}

	const created = db.all<{ userId: string; type: FeatureType; n: number }>(sql`
		SELECT fr.author_id AS userId, fr.type AS type, COUNT(*) AS n
		FROM feature_revisions fr ${publicFeature(s)}
		WHERE fr.id = ${FIRST_REVISION} AND fr.created_at >= ${s.since} ${byUser("fr.author_id", s)}
		GROUP BY fr.author_id, fr.type`);
	for (const r of created) {
		const row = get(r.userId);
		row.featuresByType[r.type] = r.n;
		row.featuresCreated += r.n;
	}

	const edits = db.all<{ userId: string; n: number }>(sql`
		SELECT fr.author_id AS userId, COUNT(*) AS n
		FROM feature_revisions fr ${publicFeature(s)}
		WHERE fr.id <> ${FIRST_REVISION} AND fr.created_at >= ${s.since} ${byUser("fr.author_id", s)}
		GROUP BY fr.author_id`);
	for (const r of edits) get(r.userId).featureEdits = r.n;

	const layerRows = db.all<{ userId: string; n: number }>(sql`
		SELECT created_by AS userId, COUNT(*) AS n FROM layers
		WHERE deleted_at IS NULL AND created_at >= ${s.since}
			${s.publicOnly ? sql.raw("AND visibility = 'public'") : sql``} ${byUser("created_by", s)}
		GROUP BY created_by`);
	for (const r of layerRows) get(r.userId).layersCreated = r.n;

	return out;
}

/** Map-wide totals; the area counts a tile once however many users uploaded it. */
function totalsOf(db: Db, s: Scope, rows: UserStats[]): UserStats {
	const total = emptyStats();
	for (const r of rows) {
		total.uploads += r.uploads;
		total.modUploads += r.modUploads;
		total.modUploadedBlocks += r.modUploadedBlocks;
		total.tiles += r.tiles;
		total.uploadedBlocks += r.uploadedBlocks;
		total.featuresCreated += r.featuresCreated;
		for (const t of FEATURE_TYPES)
			total.featuresByType[t] += r.featuresByType[t];
		total.featureEdits += r.featureEdits;
		total.layersCreated += r.layersCreated;
	}
	const [area] = db.all<{ area: number; modArea: number }>(sql`
		SELECT COUNT(*) AS area, COALESCE(SUM(viaMod), 0) AS modArea FROM (
			SELECT r.dimension_id, p.tile_x, p.tile_y, MAX(r.via_mod) AS viaMod
			FROM revisions r JOIN upload_patches p ON p.revision_id = r.id
			WHERE ${uploadedSince(s.since)}
			GROUP BY r.dimension_id, p.tile_x, p.tile_y
		)`);
	total.areaTiles = area?.area ?? 0;
	total.areaBlocks = total.areaTiles * s.tileSize * s.tileSize;
	total.modAreaTiles = area?.modArea ?? 0;
	total.modAreaBlocks = total.modAreaTiles * s.tileSize * s.tileSize;
	return total;
}

type FirstUploads = { t: number; n: number }[];

/**
 * How many tiles were first mapped in each period (by `bucket` ms), optionally by one user. A tile
 * is dated by when its data was exported, or by its upload when that is unknown.
 */
function firstUploads(db: Db, bucket: number, userId?: string): FirstUploads {
	return db.all<{ t: number; n: number }>(sql`
		SELECT (first / ${bucket}) * ${bucket} AS t, COUNT(*) AS n FROM (
			SELECT MIN(COALESCE(r.exported_at, r.created_at)) AS first
			FROM revisions r JOIN upload_patches p ON p.revision_id = r.id
			WHERE ${DONE_UPLOAD} ${userId ? sql`AND r.author_id = ${userId}` : sql``}
			GROUP BY r.dimension_id, p.tile_x, p.tile_y
		) GROUP BY 1 ORDER BY 1`);
}

/**
 * The mapped area as it grew: distinct tiles, counted from the earliest export that covered them.
 * Starts from what was already mapped when the range began.
 */
function areaHistory(
	total: FirstUploads,
	mine: FirstUploads | null,
	since: number,
	now: number,
	bucket: number,
	tileSize: number,
) {
	const first = total[0];
	if (!first) return [];
	const start = since > 0 ? Math.floor(since / bucket) * bucket : first.t;

	const grid: number[] = [];
	for (let t = start; t <= now; t += bucket) grid.push(t);
	const cumulative = (rows: FirstUploads) => {
		const added = new Map(rows.map((r) => [r.t, r.n]));
		let sum = rows.filter((r) => r.t < start).reduce((n, r) => n + r.n, 0);
		return { base: sum, at: grid.map((t) => (sum += added.get(t) ?? 0)) };
	};
	const all = cumulative(total);
	const own = mine ? cumulative(mine) : null;
	const blocks = (tiles: number) => tiles * tileSize * tileSize;

	return [
		{
			t: Math.max(start, since),
			totalBlocks: blocks(all.base),
			myBlocks: own ? blocks(own.base) : null,
		},
		...grid.map((t, i) => ({
			t: Math.min(t + bucket, now),
			totalBlocks: blocks(all.at[i] as number),
			myBlocks: own ? blocks(own.at[i] as number) : null,
		})),
	];
}

/** What is the same for every visitor; reused for `CACHE_MS`. */
type Everyone = {
	at: number;
	since: number | null;
	leaderboard: (UserStats & {
		userId: string;
		username: string;
		avatarUrl: string | null;
	})[];
	totals: UserStats;
	firstUploads: FirstUploads;
};

const caches = new WeakMap<Db, Map<string, Everyone>>();

/** Forgets the reused figures (for tests). */
export const resetStatsCache = (db: Db) => caches.delete(db);

function everyone(
	db: Db,
	range: StatsRange,
	tileSize: number,
	now: number,
): Everyone {
	const cache = caches.get(db) ?? new Map<string, Everyone>();
	caches.set(db, cache);
	const key = `${range}|${tileSize}`;
	const hit = cache.get(key);
	if (hit && now - hit.at < CACHE_MS) return hit;

	const days = RANGE_DAYS[range];
	const since = days === null ? null : now - days * DAY;
	const scope = { since: since ?? 0, tileSize, publicOnly: true };
	const all = collect(db, scope);
	const ids = [...all.keys()];
	const people = ids.length
		? db
				.select({
					id: users.id,
					username: users.username,
					avatarUrl: users.avatarUrl,
				})
				.from(users)
				.where(inArray(users.id, ids))
				.all()
		: [];
	const fresh: Everyone = {
		at: now,
		since,
		leaderboard: people.map((p) => ({
			userId: p.id,
			username: p.username,
			avatarUrl: p.avatarUrl,
			...(all.get(p.id) as UserStats),
		})),
		totals: totalsOf(db, scope, [...all.values()]),
		firstUploads: firstUploads(db, bucketOf(range)),
	};
	cache.set(key, fresh);
	return fresh;
}

/** The week is drawn in 6 hour steps, everything longer in days. */
const bucketOf = (range: StatsRange) => (range === "7d" ? 6 * HOUR : DAY);

export const statsRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Stats",
		summary: "Contribution statistics and leaderboard",
		description:
			"Public. `me` is your own activity (null when not logged in) and includes private layers; `leaderboard` and `totals` (everyone combined) only count public layers and are reused for a minute. `modUploads`, `modUploadedBlocks` (volume, repeats counted) and `modAreaTiles`/`modAreaBlocks` (distinct ground) are the part sent by the in-game mod (AOMC Webmapper, or whatever `MOD_USER_AGENTS` lists); it is also counted in the other numbers. `areaHistory` is the mapped area over time, for the whole map and for you, by the date the uploaded data was exported. `range` is `all` (default), `30d` or `7d`.",
		fails: [400],
	}),
	validate("query", statsQuerySchema),
	(c) => {
		const { db, user, map } = c.var;
		const { range } = c.req.valid("query");
		const now = Date.now();
		const shared = everyone(db, range, map.tileSize, now);
		const since = shared.since ?? 0;

		const me = user
			? (collect(db, {
					since,
					tileSize: map.tileSize,
					publicOnly: false,
					userId: user.id,
				}).get(user.id) ?? emptyStats())
			: null;

		return c.json({
			range,
			since: shared.since,
			me,
			leaderboard: shared.leaderboard,
			totals: shared.totals,
			areaHistory: areaHistory(
				shared.firstUploads,
				user ? firstUploads(db, bucketOf(range), user.id) : null,
				since,
				now,
				bucketOf(range),
				map.tileSize,
			),
		});
	},
);

import { type StatsRange, statsQuerySchema } from "@aomc/shared";
import { inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

const DAY = 24 * 3600_000;
const RANGE_DAYS: Record<StatsRange, number | null> = {
	all: null,
	"30d": 30,
	"7d": 7,
};

type FeatureType = "pin" | "line" | "polygon";

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
		WHERE r.kind = 'upload' AND r.status = 'done' AND r.reverted = 0
			AND COALESCE(r.completed_at, r.created_at) >= ${s.since} ${byUser("r.author_id", s)}
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
		for (const t of ["pin", "line", "polygon"] as const)
			total.featuresByType[t] += r.featuresByType[t];
		total.featureEdits += r.featureEdits;
		total.layersCreated += r.layersCreated;
	}
	const [area] = db.all<{ area: number; modArea: number }>(sql`
		SELECT COUNT(*) AS area, COALESCE(SUM(viaMod), 0) AS modArea FROM (
			SELECT r.dimension_id, p.tile_x, p.tile_y, MAX(r.via_mod) AS viaMod
			FROM revisions r JOIN upload_patches p ON p.revision_id = r.id
			WHERE r.kind = 'upload' AND r.status = 'done' AND r.reverted = 0
				AND COALESCE(r.completed_at, r.created_at) >= ${s.since}
			GROUP BY r.dimension_id, p.tile_x, p.tile_y
		)`);
	total.areaTiles = area?.area ?? 0;
	total.areaBlocks = total.areaTiles * s.tileSize * s.tileSize;
	total.modAreaTiles = area?.modArea ?? 0;
	total.modAreaBlocks = total.modAreaTiles * s.tileSize * s.tileSize;
	return total;
}

const HOUR = 3600_000;

/**
 * How many tiles were first mapped in each period (by `bucket` ms), optionally by one user. A tile
 * is dated by when its data was exported, or by its upload when that is unknown. An export is
 * never dated after its upload.
 */
function firstUploads(db: Db, bucket: number, userId?: string) {
	const uploaded = sql`COALESCE(r.completed_at, r.created_at)`;
	const date = sql`COALESCE(MIN(r.exported_at, ${uploaded}), ${uploaded})`;
	return db.all<{ t: number; n: number }>(sql`
		SELECT (first / ${bucket}) * ${bucket} AS t, COUNT(*) AS n FROM (
			SELECT MIN(${date}) AS first
			FROM revisions r JOIN upload_patches p ON p.revision_id = r.id
			WHERE r.kind = 'upload' AND r.status = 'done' AND r.reverted = 0
				${userId ? sql`AND r.author_id = ${userId}` : sql``}
			GROUP BY r.dimension_id, p.tile_x, p.tile_y
		) GROUP BY 1 ORDER BY 1`);
}

/**
 * The mapped area as it grew: distinct tiles, counted from the earliest export that covered them.
 * Starts from what was already mapped when the range began.
 */
function areaHistory(
	db: Db,
	since: number,
	now: number,
	tileSize: number,
	userId: string | null,
) {
	const bucket = since > 0 && now - since <= 7 * DAY ? 6 * HOUR : DAY;
	const total = firstUploads(db, bucket);
	const first = total[0];
	if (!first) return [];
	const mine = userId ? firstUploads(db, bucket, userId) : null;
	const start = since > 0 ? Math.floor(since / bucket) * bucket : first.t;

	const grid: number[] = [];
	for (let t = start; t <= now; t += bucket) grid.push(t);
	const cumulative = (rows: { t: number; n: number }[]) => {
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

export const statsRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Stats",
		summary: "Contribution statistics and leaderboard",
		description:
			"Public. `me` is your own activity (null when not logged in) and includes private layers; `leaderboard` and `totals` (everyone combined) only count public layers. `modUploads`, `modUploadedBlocks` (volume, repeats counted) and `modAreaTiles`/`modAreaBlocks` (distinct ground) are the part sent by the in-game mod (AOMC Webmapper, or whatever `MOD_USER_AGENTS` lists); it is also counted in the other numbers. `areaHistory` is the mapped area over time, for the whole map and for you, by the date the uploaded data was exported. `range` is `all` (default), `30d` or `7d`.",
		fails: [400],
	}),
	validator("query", statsQuerySchema),
	async (c) => {
		const { db, user, map } = c.var;
		const { range } = c.req.valid("query");
		const days = RANGE_DAYS[range];
		const now = Date.now();
		const since = days === null ? null : now - days * DAY;
		const base = { since: since ?? 0, tileSize: map.tileSize };

		const all = collect(db, { ...base, publicOnly: true });
		const ids = [...all.keys()];
		const people = ids.length
			? await db
					.select({
						id: users.id,
						username: users.username,
						avatarUrl: users.avatarUrl,
					})
					.from(users)
					.where(inArray(users.id, ids))
			: [];
		const leaderboard = people.map((p) => ({
			userId: p.id,
			username: p.username,
			avatarUrl: p.avatarUrl,
			...(all.get(p.id) as UserStats),
		}));

		const me = user
			? (collect(db, { ...base, publicOnly: false, userId: user.id }).get(
					user.id,
				) ?? emptyStats())
			: null;

		return c.json({
			range,
			since,
			me,
			leaderboard,
			totals: totalsOf(db, { ...base, publicOnly: true }, [...all.values()]),
			areaHistory: areaHistory(
				db,
				base.since,
				now,
				map.tileSize,
				user?.id ?? null,
			),
		});
	},
);

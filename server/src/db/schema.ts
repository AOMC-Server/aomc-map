import {
	DEFAULT_PRELOAD,
	DIMENSION_THEMES,
	FEATURE_TYPES,
	inviteRoleSchema,
	layerRoleSchema,
	layerVisibilitySchema,
	memberRoleSchema,
	type PreloadRing,
	TOKEN_SCOPES,
	type TokenScope,
} from "@aomc/shared";
import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

/** The values of a zod enum, as drizzle wants them. */
const options = <T extends string>(schema: { options: T[] }) =>
	schema.options as [T, ...T[]];
const id = () => integer("id").primaryKey({ autoIncrement: true });
const bool = (name: string) => integer(name, { mode: "boolean" });
const createdAt = () =>
	integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now());

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	username: text("username").notNull(),
	avatarUrl: text("avatar_url"),
	createdAt: createdAt(),
	lastLoginAt: integer("last_login_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(), // sha256 of the cookie value
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	expiresAt: integer("expires_at").notNull(),
});

export const apiTokens = sqliteTable("api_tokens", {
	id: id(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	tokenHash: text("token_hash").notNull().unique(),
	createdAt: createdAt(),
	lastUsedAt: integer("last_used_at"),
	/** null = never expires. */
	expiresAt: integer("expires_at"),
	/** See TOKEN_SCOPES. Tokens from before scopes existed have all of them. */
	scopes: text("scopes", { mode: "json" })
		.$type<TokenScope[]>()
		.notNull()
		.default([...TOKEN_SCOPES]),
});

/** The one map this server hosts: a single row, created on first boot. */
export const mapInfo = sqliteTable("map_info", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
	tileSize: integer("tile_size").notNull(),
	headRev: integer("head_rev").notNull().default(0),
	/** Bumped when history is rewritten (an upload is deleted), so cached tiles are not reused. */
	epoch: integer("epoch").notNull().default(0),
	/** Read only for everyone but owners. */
	maintenance: bool("maintenance").notNull().default(false),
	/** Set when history must be rebuilt in export order (after legacy reverts were removed); queued on boot. */
	recomputePending: bool("recompute_pending").notNull().default(false),
	createdAt: createdAt(),
});

/** Explicit roles. Everyone else is an implicit editor (logged in) or viewer (anonymous). */
export const members = sqliteTable("members", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	role: text("role", { enum: options(memberRoleSchema) }).notNull(),
	createdAt: createdAt(),
});

export const pendingOwners = sqliteTable("pending_owners", {
	discordId: text("discord_id").primaryKey(),
});

export const dimensions = sqliteTable("dimensions", {
	id: id(),
	slug: text("slug").notNull().unique(),
	name: text("name").notNull(),
	sortOrder: integer("sort_order").notNull().default(0),
	archived: bool("archived").notNull().default(false),
	/**
	 * Blocks of the reference dimension (the overworld, scale 1) that one block of this
	 * dimension spans: 8 for the Nether. null means the coordinates are not comparable
	 * with other dimensions (the End).
	 */
	scale: real("scale"),
	/** Block icon and interface colours; see DIMENSION_THEMES. */
	theme: text("theme", { enum: DIMENSION_THEMES })
		.notNull()
		.default("overworld"),
	/** Low resolution tiles viewers keep loaded around spawn; see preloadRingSchema. */
	preload: text("preload", { mode: "json" })
		.$type<PreloadRing[]>()
		.notNull()
		.default(DEFAULT_PRELOAD),
	/** How Xaero's Minimap names the dimension in shared waypoints; see xaeroDimensionSchema. */
	xaeroDimension: text("xaero_dimension").notNull().default("dim%0"),
	createdAt: createdAt(),
});

export const revisions = sqliteTable(
	"revisions",
	{
		id: id(),
		rev: integer("rev").unique(), // assigned when the job completes
		kind: text("kind", { enum: ["upload"] }).notNull(),
		dimensionId: integer("dimension_id").references(() => dimensions.id),
		authorId: text("author_id")
			.notNull()
			.references(() => users.id),
		status: text("status", {
			enum: ["pending", "processing", "done", "failed"],
		})
			.notNull()
			.default("pending"),
		error: text("error"),
		bboxMinX: integer("bbox_min_x"),
		bboxMinZ: integer("bbox_min_z"),
		bboxMaxX: integer("bbox_max_x"),
		bboxMaxZ: integer("bbox_max_z"),
		fileCount: integer("file_count").notNull().default(0),
		/** Sent by the in-game mod (its User-Agent matched MOD_USER_AGENTS); for statistics only. */
		viaMod: bool("via_mod").notNull().default(false),
		createdAt: createdAt(),
		/** When the uploaded export was made (from its file name); null = when it was uploaded. */
		exportedAt: integer("exported_at"),
		completedAt: integer("completed_at"),
	},
	(t) => [
		index("revisions_dimension_status").on(t.dimensionId, t.status),
		index("revisions_author").on(t.authorId),
	],
);

export const uploadPatches = sqliteTable(
	"upload_patches",
	{
		revisionId: integer("revision_id")
			.notNull()
			.references(() => revisions.id, { onDelete: "cascade" }),
		tileX: integer("tile_x").notNull(),
		tileY: integer("tile_y").notNull(),
		blobHash: text("blob_hash").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.revisionId, t.tileX, t.tileY] }),
		index("upload_patches_tile").on(t.tileX, t.tileY),
	],
);

/** The files an upload was made of, so sending the same file again can be skipped. */
export const uploadFiles = sqliteTable(
	"upload_files",
	{
		revisionId: integer("revision_id")
			.notNull()
			.references(() => revisions.id, { onDelete: "cascade" }),
		dimensionId: integer("dimension_id")
			.notNull()
			.references(() => dimensions.id, { onDelete: "cascade" }),
		x: integer("x").notNull(),
		z: integer("z").notNull(),
		/** sha256 of the PNG as sent. */
		hash: text("hash").notNull(),
	},
	(t) => [
		index("upload_files_dimension_hash").on(t.dimensionId, t.hash),
		index("upload_files_revision").on(t.revisionId),
	],
);

export const tileVersions = sqliteTable(
	"tile_versions",
	{
		dimensionId: integer("dimension_id")
			.notNull()
			.references(() => dimensions.id, { onDelete: "cascade" }),
		zoom: integer("zoom").notNull(),
		tileX: integer("tile_x").notNull(),
		tileY: integer("tile_y").notNull(),
		rev: integer("rev").notNull(),
		blobHash: text("blob_hash"), // null = empty tile at this rev
	},
	(t) => [
		primaryKey({ columns: [t.dimensionId, t.zoom, t.tileX, t.tileY, t.rev] }),
	],
);

/** Where a history recompute writes the new tile_versions before swapping them in. */
export const tileVersionsRebuild = sqliteTable(
	"tile_versions_rebuild",
	{
		dimensionId: integer("dimension_id").notNull(),
		zoom: integer("zoom").notNull(),
		tileX: integer("tile_x").notNull(),
		tileY: integer("tile_y").notNull(),
		rev: integer("rev").notNull(),
		blobHash: text("blob_hash"),
	},
	(t) => [
		primaryKey({ columns: [t.dimensionId, t.zoom, t.tileX, t.tileY, t.rev] }),
	],
);

export const layers = sqliteTable(
	"layers",
	{
		id: id(),
		dimensionId: integer("dimension_id")
			.notNull()
			.references(() => dimensions.id),
		name: text("name").notNull(),
		color: text("color").notNull(),
		hiddenByDefault: bool("hidden_by_default").notNull().default(false),
		visibility: text("visibility", { enum: options(layerVisibilitySchema) })
			.notNull()
			.default("public"),
		sortOrder: integer("sort_order").notNull().default(0),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
		deletedAt: integer("deleted_at"),
	},
	(t) => [index("layers_dimension").on(t.dimensionId)],
);

export const layerMembers = sqliteTable(
	"layer_members",
	{
		layerId: integer("layer_id")
			.notNull()
			.references(() => layers.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role", { enum: options(layerRoleSchema) }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.layerId, t.userId] })],
);

export const features = sqliteTable(
	"features",
	{
		id: id(),
		layerId: integer("layer_id")
			.notNull()
			.references(() => layers.id, { onDelete: "cascade" }),
		/** Position in the layer (lower first). Not versioned: reordering is not an edit of the feature. */
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: createdAt(),
	},
	(t) => [index("features_layer_order").on(t.layerId, t.sortOrder)],
);

export const featureRevisions = sqliteTable(
	"feature_revisions",
	{
		id: id(),
		featureId: integer("feature_id")
			.notNull()
			.references(() => features.id, { onDelete: "cascade" }),
		authorId: text("author_id")
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
		deleted: bool("deleted").notNull().default(false),
		type: text("type", { enum: FEATURE_TYPES }).notNull(),
		name: text("name").notNull(),
		popup: text("popup").notNull().default(""),
		color: text("color"),
		geometry: text("geometry", { mode: "json" }).notNull(),
	},
	(t) => [
		index("feature_revisions_feature").on(t.featureId, t.createdAt),
		index("feature_revisions_author").on(t.authorId),
	],
);

export const invites = sqliteTable("invites", {
	id: id(),
	tokenHash: text("token_hash").notNull().unique(),
	/** null: a map invite (makes a moderator). */
	layerId: integer("layer_id").references(() => layers.id, {
		onDelete: "cascade",
	}),
	role: text("role", { enum: options(inviteRoleSchema) }).notNull(),
	createdBy: text("created_by")
		.notNull()
		.references(() => users.id),
	expiresAt: integer("expires_at"),
	maxUses: integer("max_uses"),
	uses: integer("uses").notNull().default(0),
	revoked: bool("revoked").notNull().default(false),
});

/** Short links to a view of the map: /s/<code> redirects to /?<query>. */
export const shortLinks = sqliteTable("short_links", {
	code: text("code").primaryKey(),
	/** The view's query string, without the "?"; one link per view. */
	query: text("query").notNull().unique(),
	/** null: made by an anonymous visitor. */
	createdBy: text("created_by").references(() => users.id),
	createdAt: createdAt(),
});

export const jobs = sqliteTable("jobs", {
	id: id(),
	type: text("type", {
		enum: ["process_upload", "erase_upload", "recompute_history"],
	}).notNull(),
	payload: text("payload", { mode: "json" }).notNull(),
	status: text("status", { enum: ["pending", "processing", "done", "failed"] })
		.notNull()
		.default("pending"),
	attempts: integer("attempts").notNull().default(0),
	/** Why a job that has no revision to carry it (a history recompute) failed. */
	error: text("error"),
	createdAt: createdAt(),
	completedAt: integer("completed_at"),
});

/** The size of every stored tile image, recorded when it is written, so storage is summed rather than measured. */
export const blobFiles = sqliteTable("blobs", {
	hash: text("hash").primaryKey(),
	bytes: integer("bytes").notNull(),
	createdAt: createdAt(),
});

/** Append-only: a row after each upload, upload deletion, blob cleanup and server start. */
export const storageHistory = sqliteTable("storage_history", {
	id: id(),
	at: integer("at").notNull(),
	reason: text("reason", {
		enum: ["upload", "erase", "gc", "boot"],
	}).notNull(),
	blobCount: integer("blob_count").notNull(),
	blobBytes: integer("blob_bytes").notNull(),
	/** The part of the above that the map's history still uses; the rest awaits scripts/gc-blobs.ts. */
	referencedBlobs: integer("referenced_blobs").notNull(),
	referencedBytes: integer("referenced_bytes").notNull(),
	dbBytes: integer("db_bytes").notNull(),
});

/**
 * Counters of what the server sent. `hour` is the start of the period a row covers: a minute for
 * the last day, an hour for the last 90 days, and a day before that.
 */
export const trafficHourly = sqliteTable(
	"traffic_hourly",
	{
		hour: integer("hour").notNull(),
		category: text("category", {
			enum: ["tiles", "blobs", "preview", "api", "auth", "static"],
		}).notNull(),
		/** Only for tiles and blobs; "" otherwise. */
		domain: text("domain").notNull().default(""),
		requests: integer("requests").notNull().default(0),
		bytes: integer("bytes").notNull().default(0),
		s2xx: integer("s2xx").notNull().default(0),
		s3xx: integer("s3xx").notNull().default(0),
		s4xx: integer("s4xx").notNull().default(0),
		s5xx: integer("s5xx").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.hour, t.category, t.domain] })],
);

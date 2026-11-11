import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

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
});

/** The one map this server hosts: a single row, created on first boot. */
export const mapInfo = sqliteTable("map_info", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
	tileSize: integer("tile_size").notNull(),
	headRev: integer("head_rev").notNull().default(0),
	/** Bumped when history is rewritten (an upload is deleted), so cached tiles are not reused. */
	epoch: integer("epoch").notNull().default(0),
	createdAt: createdAt(),
});

/** Explicit roles. Everyone else is an implicit editor (logged in) or viewer (anonymous). */
export const members = sqliteTable("members", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	role: text("role", { enum: ["moderator", "owner"] }).notNull(),
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
	createdAt: createdAt(),
});

export const revisions = sqliteTable("revisions", {
	id: id(),
	rev: integer("rev").unique(), // assigned when the job completes
	// "revert" and "unrevert" only exist in history from before uploads could be deleted.
	kind: text("kind", { enum: ["upload", "revert", "unrevert"] }).notNull(),
	dimensionId: integer("dimension_id").references(() => dimensions.id),
	authorId: text("author_id")
		.notNull()
		.references(() => users.id),
	targetRevisionId: integer("target_revision_id"),
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
	reverted: bool("reverted").notNull().default(false),
	createdAt: createdAt(),
	/** When the uploaded export was made (from its file name); null = when it was uploaded. */
	exportedAt: integer("exported_at"),
	completedAt: integer("completed_at"),
});

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
	(t) => [primaryKey({ columns: [t.revisionId, t.tileX, t.tileY] })],
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
		visibility: text("visibility", { enum: ["public", "private"] })
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
		role: text("role", { enum: ["viewer", "editor"] }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.layerId, t.userId] })],
);

export const features = sqliteTable("features", {
	id: id(),
	layerId: integer("layer_id")
		.notNull()
		.references(() => layers.id, { onDelete: "cascade" }),
	createdAt: createdAt(),
});

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
		type: text("type", { enum: ["pin", "line", "polygon"] }).notNull(),
		name: text("name").notNull(),
		popup: text("popup").notNull().default(""),
		color: text("color"),
		geometry: text("geometry", { mode: "json" }).notNull(),
	},
	(t) => [index("feature_revisions_feature").on(t.featureId, t.createdAt)],
);

export const invites = sqliteTable("invites", {
	id: id(),
	tokenHash: text("token_hash").notNull().unique(),
	/** null: a map invite (makes a moderator). */
	layerId: integer("layer_id").references(() => layers.id, {
		onDelete: "cascade",
	}),
	role: text("role").notNull(),
	createdBy: text("created_by")
		.notNull()
		.references(() => users.id),
	expiresAt: integer("expires_at"),
	maxUses: integer("max_uses"),
	uses: integer("uses").notNull().default(0),
	revoked: bool("revoked").notNull().default(false),
});

export const jobs = sqliteTable("jobs", {
	id: id(),
	type: text("type", { enum: ["process_upload", "erase_upload"] }).notNull(),
	payload: text("payload", { mode: "json" }).notNull(),
	status: text("status", { enum: ["pending", "processing", "done", "failed"] })
		.notNull()
		.default("pending"),
	attempts: integer("attempts").notNull().default(0),
	createdAt: createdAt(),
});

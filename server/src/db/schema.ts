import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
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
});

export const maps = sqliteTable(
	"maps",
	{
		id: id(),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		ownerId: text("owner_id").references(() => users.id), // null for the setup map
		visibility: text("visibility", { enum: ["public", "private"] })
			.notNull()
			.default("private"),
		isDefault: bool("is_default").notNull().default(false),
		tileSize: integer("tile_size").notNull(),
		headRev: integer("head_rev").notNull().default(0),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("maps_one_default")
			.on(t.isDefault)
			.where(sql`${t.isDefault} = 1`),
	],
);

export const mapMembers = sqliteTable(
	"map_members",
	{
		mapId: integer("map_id")
			.notNull()
			.references(() => maps.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role", {
			enum: ["viewer", "editor", "moderator", "owner"],
		}).notNull(),
		addedBy: text("added_by"),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.mapId, t.userId] })],
);

export const pendingOwners = sqliteTable(
	"pending_owners",
	{
		mapId: integer("map_id")
			.notNull()
			.references(() => maps.id, { onDelete: "cascade" }),
		discordId: text("discord_id").notNull(),
	},
	(t) => [primaryKey({ columns: [t.mapId, t.discordId] })],
);

export const dimensions = sqliteTable(
	"dimensions",
	{
		id: id(),
		mapId: integer("map_id")
			.notNull()
			.references(() => maps.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
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
	},
	(t) => [uniqueIndex("dimensions_map_slug").on(t.mapId, t.slug)],
);

export const revisions = sqliteTable(
	"revisions",
	{
		id: id(),
		mapId: integer("map_id")
			.notNull()
			.references(() => maps.id, { onDelete: "cascade" }),
		rev: integer("rev"), // assigned when the job completes
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
		completedAt: integer("completed_at"),
	},
	(t) => [uniqueIndex("revisions_map_rev").on(t.mapId, t.rev)],
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
		mapId: integer("map_id")
			.notNull()
			.references(() => maps.id, { onDelete: "cascade" }),
		dimensionId: integer("dimension_id")
			.notNull()
			.references(() => dimensions.id),
		name: text("name").notNull(),
		color: text("color").notNull(),
		hiddenByDefault: bool("hidden_by_default").notNull().default(false),
		visibility: text("visibility", { enum: ["inherit", "private"] })
			.notNull()
			.default("inherit"),
		sortOrder: integer("sort_order").notNull().default(0),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
		deletedAt: integer("deleted_at"),
	},
	(t) => [index("layers_map").on(t.mapId, t.dimensionId)],
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

export const invites = sqliteTable(
	"invites",
	{
		id: id(),
		tokenHash: text("token_hash").notNull().unique(),
		mapId: integer("map_id").references(() => maps.id, { onDelete: "cascade" }),
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
	},
	(t) => [
		check(
			"invites_one_target",
			sql`(${t.mapId} IS NOT NULL) + (${t.layerId} IS NOT NULL) = 1`,
		),
	],
);

export const jobs = sqliteTable("jobs", {
	id: id(),
	type: text("type", { enum: ["process_upload", "apply_revert"] }).notNull(),
	payload: text("payload", { mode: "json" }).notNull(),
	status: text("status", { enum: ["pending", "processing", "done", "failed"] })
		.notNull()
		.default("pending"),
	attempts: integer("attempts").notNull().default(0),
	createdAt: createdAt(),
	startedAt: integer("started_at"),
	finishedAt: integer("finished_at"),
	error: text("error"),
});

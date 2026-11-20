import * as z from "zod/mini";
import { MIN_ZOOM } from "./view";

export const roleSchema = z.enum(["viewer", "editor", "moderator", "owner"]);
export type Role = z.infer<typeof roleSchema>;

export const nonEmpty = (o: object) => Object.keys(o).length > 0;

/** Longest name of a map, dimension, layer, token or feature. */
export const MAX_NAME = 100;

export const MAX_COORD = 30_000_000;

export const blockCoord = z
	.int()
	.check(z.minimum(-MAX_COORD), z.maximum(MAX_COORD));

export const coordSchema = z.object({ x: blockCoord, z: blockCoord });

export const uploadCoordsSchema = z.array(coordSchema);

/** Where each uploaded file came from, folders included: the export date is read from it. */
export const uploadPathSchema = z.string().check(z.maxLength(1000));
export const uploadPathsSchema = z.array(uploadPathSchema);

const slugSchema = z
	.string()
	.check(
		z.minLength(1),
		z.maxLength(40),
		z.regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _ only"),
	);

const entityName = z
	.string()
	.check(z.trim(), z.minLength(1), z.maxLength(MAX_NAME));

export const updateMapSchema = z
	.object({
		name: z.optional(entityName),
		/** Read only for everyone but owners. */
		maintenance: z.optional(z.boolean()),
	})
	.check(z.refine(nonEmpty, "nothing to update"));

/**
 * Overworld blocks per block of the dimension (1 for the overworld, 8 for the Nether).
 * null: the coordinates cannot be mapped to other dimensions (the End).
 */
export const dimensionScaleSchema = z.nullable(
	z.number().check(z.positive(), z.maximum(1_000_000)),
);

/** Picks the dimension's block icon and the interface colours while it is shown. */
export const DIMENSION_THEMES = [
	"overworld",
	"nether",
	"end",
	"unknown",
] as const;
export const dimensionThemeSchema = z.enum(DIMENSION_THEMES);
export type DimensionTheme = z.infer<typeof dimensionThemeSchema>;

/** The theme a dimension most likely wants, from its slug. */
export function guessDimensionTheme(slug: string): DimensionTheme {
	if (slug.includes("nether")) return "nether";
	if (slug.includes("end")) return "end";
	return "overworld";
}

/**
 * How Xaero's Minimap names the dimension in a shared waypoint ("Internal-<id>"): dim%0 for the
 * overworld, dim%-1 for the Nether, dim%1 for the End. A colon would end the field early.
 */
export const xaeroDimensionSchema = z
	.string()
	.check(
		z.trim(),
		z.minLength(1),
		z.maxLength(100),
		z.regex(/^[^:\s]+$/, "no colons or spaces"),
	);

/** The Xaero dimension id a dimension most likely has, from its theme. */
export function guessXaeroDimension(theme: DimensionTheme): string {
	if (theme === "nether") return "dim%-1";
	if (theme === "end") return "dim%1";
	return "dim%0";
}

/**
 * Low resolution tiles around spawn (0, 0) that viewers load in the background and keep, so
 * there is always something to show there. Tile level n is 1/2^n resolution; radius is in blocks
 * of the dimension.
 */
export const preloadRingSchema = z.object({
	level: z.int().check(z.minimum(0), z.maximum(12)),
	radius: z.int().check(z.minimum(0), z.maximum(MAX_COORD)),
});
export type PreloadRing = z.infer<typeof preloadRingSchema>;
export const dimensionPreloadSchema = z
	.array(preloadRingSchema)
	.check(z.maxLength(8));

export const DEFAULT_PRELOAD: PreloadRing[] = [
	{ level: 2, radius: 2048 },
	{ level: 3, radius: 8192 },
	{ level: 4, radius: 16384 },
];

export const createDimensionSchema = z.object({
	slug: slugSchema,
	name: entityName,
	scale: z.optional(dimensionScaleSchema),
	/** Defaults to a guess from the slug. */
	theme: z.optional(dimensionThemeSchema),
	/** Defaults to DEFAULT_PRELOAD. */
	preload: z.optional(dimensionPreloadSchema),
	/** Defaults to a guess from the theme. */
	xaeroDimension: z.optional(xaeroDimensionSchema),
});

export const updateDimensionSchema = z
	.object({
		name: z.optional(entityName),
		sortOrder: z.optional(z.int()),
		archived: z.optional(z.boolean()),
		scale: z.optional(dimensionScaleSchema),
		theme: z.optional(dimensionThemeSchema),
		preload: z.optional(dimensionPreloadSchema),
		xaeroDimension: z.optional(xaeroDimensionSchema),
	})
	.check(z.refine(nonEmpty, "nothing to update"));

/** Most layers a shared view can list. */
export const MAX_SHARED_LAYERS = 500;

/**
 * A view saved behind a short link: where the camera is, in which dimension, as of which
 * revision (none: the latest), and which layers are shown (none listed: each layer's default).
 */
export const shareViewSchema = z.object({
	dim: slugSchema,
	x: blockCoord,
	z: blockCoord,
	zoom: z.number().check(z.minimum(MIN_ZOOM), z.maximum(64)),
	rev: z.optional(z.int().check(z.minimum(0))),
	layers: z.optional(
		z.array(z.int().check(z.positive())).check(z.maxLength(MAX_SHARED_LAYERS)),
	),
});
export type ShareView = z.infer<typeof shareViewSchema>;

/** Roles stored for a member. Everyone logged in is an editor and everyone else a viewer without one. */
export const memberRoleSchema = z.enum(["moderator", "owner"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const setMemberSchema = z.object({
	userId: z.string().check(z.minLength(1)),
	role: memberRoleSchema,
});

export const updateMemberSchema = z.object({ role: memberRoleSchema });

export const DEFAULT_TOKEN_EXPIRY_DAYS = 180;
export const MAX_TOKEN_EXPIRY_DAYS = 3650;
export const MAX_TOKENS_PER_USER = 25;

/**
 * What an API token may do, on top of its owner's role:
 * - read: see what the owner sees (private layers, their role); without it GETs are anonymous
 * - upload: upload Xaero exports and delete your own uploads
 * - features: create and edit layers, pins, lines and areas, and share layers
 * - moderate: use moderator powers (delete any upload, restore features, edit dimensions)
 * - manage: use owner powers (members, map invites, map settings); implies moderate
 */
export const TOKEN_SCOPES = [
	"read",
	"upload",
	"features",
	"moderate",
	"manage",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const DEFAULT_TOKEN_SCOPES: TokenScope[] = [
	"read",
	"upload",
	"features",
];

/** Sorted, without duplicates, and with the scopes that `manage` implies. */
export function normalizeScopes(scopes: readonly TokenScope[]): TokenScope[] {
	const set = new Set(scopes);
	if (set.has("manage")) set.add("moderate");
	return TOKEN_SCOPES.filter((s) => set.has(s));
}

export const createTokenSchema = z.object({
	name: entityName,
	/** null = never expires. */
	expiresInDays: z._default(
		z.nullable(z.int().check(z.minimum(1), z.maximum(MAX_TOKEN_EXPIRY_DAYS))),
		DEFAULT_TOKEN_EXPIRY_DAYS,
	),
	scopes: z.pipe(
		z._default(
			z.array(z.enum(TOKEN_SCOPES)).check(z.minLength(1)),
			DEFAULT_TOKEN_SCOPES,
		),
		z.transform((scopes: TokenScope[]) => normalizeScopes(scopes)),
	),
});

export const STATS_RANGES = ["all", "30d", "7d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export const statsQuerySchema = z.object({
	range: z._default(z.enum(STATS_RANGES), "all"),
});

export const ADMIN_STATS_RANGES = [
	"1h",
	"6h",
	"24h",
	"7d",
	"30d",
	"90d",
	"all",
] as const;
export type AdminStatsRange = (typeof ADMIN_STATS_RANGES)[number];

export const adminStatsQuerySchema = z.object({
	range: z._default(z.enum(ADMIN_STATS_RANGES), "7d"),
});

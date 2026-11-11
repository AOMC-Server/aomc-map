import { z } from "zod";

export const roleSchema = z.enum(["viewer", "editor", "moderator", "owner"]);
export type Role = z.infer<typeof roleSchema>;

export const nonEmpty = (o: object) => Object.keys(o).length > 0;

export const MAX_COORD = 30_000_000;

export const blockCoord = z.number().int().min(-MAX_COORD).max(MAX_COORD);

export const coordSchema = z.object({ x: blockCoord, z: blockCoord });

export const uploadCoordsSchema = z.array(coordSchema);

/** Where each uploaded file came from, folders included: the export date is read from it. */
export const uploadPathsSchema = z.array(z.string().max(1000));

const slugSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _ only");

export const updateMapSchema = z
	.object({ name: z.string().trim().min(1).max(100).optional() })
	.refine(nonEmpty, "nothing to update");

/**
 * Overworld blocks per block of the dimension (1 for the overworld, 8 for the Nether).
 * null: the coordinates cannot be mapped to other dimensions (the End).
 */
export const dimensionScaleSchema = z
	.number()
	.positive()
	.max(1_000_000)
	.nullable();

/** Picks the dimension's block icon and the interface colours while it is shown. */
export const DIMENSION_THEMES = ["overworld", "nether", "end"] as const;
export const dimensionThemeSchema = z.enum(DIMENSION_THEMES);
export type DimensionTheme = z.infer<typeof dimensionThemeSchema>;

/** The theme a dimension most likely wants, from its slug. */
export function guessDimensionTheme(slug: string): DimensionTheme {
	if (slug.includes("nether")) return "nether";
	if (slug.includes("end")) return "end";
	return "overworld";
}

/**
 * Low resolution tiles around spawn (0, 0) that viewers load in the background and keep, so
 * there is always something to show there. Tile level n is 1/2^n resolution; radius is in blocks
 * of the dimension.
 */
export const preloadRingSchema = z.object({
	level: z.number().int().min(0).max(12),
	radius: z.number().int().min(0).max(MAX_COORD),
});
export type PreloadRing = z.infer<typeof preloadRingSchema>;
export const dimensionPreloadSchema = z.array(preloadRingSchema).max(8);

export const DEFAULT_PRELOAD: PreloadRing[] = [
	{ level: 2, radius: 2048 },
	{ level: 3, radius: 8192 },
	{ level: 4, radius: 16384 },
];

export const createDimensionSchema = z.object({
	slug: slugSchema,
	name: z.string().trim().min(1).max(100),
	scale: dimensionScaleSchema.optional(),
	/** Defaults to a guess from the slug. */
	theme: dimensionThemeSchema.optional(),
	/** Defaults to DEFAULT_PRELOAD. */
	preload: dimensionPreloadSchema.optional(),
});

export const updateDimensionSchema = z
	.object({
		name: z.string().trim().min(1).max(100).optional(),
		sortOrder: z.number().int().optional(),
		archived: z.boolean().optional(),
		scale: dimensionScaleSchema.optional(),
		theme: dimensionThemeSchema.optional(),
		preload: dimensionPreloadSchema.optional(),
	})
	.refine(nonEmpty, "nothing to update");

/** Roles stored for a member. Everyone logged in is an editor and everyone else a viewer without one. */
export const memberRoleSchema = z.enum(["moderator", "owner"]);

export const setMemberSchema = z.object({
	userId: z.string().min(1),
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
	name: z.string().trim().min(1).max(100),
	/** null = never expires. */
	expiresInDays: z
		.number()
		.int()
		.min(1)
		.max(MAX_TOKEN_EXPIRY_DAYS)
		.nullable()
		.default(DEFAULT_TOKEN_EXPIRY_DAYS),
	scopes: z
		.array(z.enum(TOKEN_SCOPES))
		.min(1)
		.default(DEFAULT_TOKEN_SCOPES)
		.transform(normalizeScopes),
});

export const STATS_RANGES = ["all", "30d", "7d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export const statsQuerySchema = z.object({
	range: z.enum(STATS_RANGES).default("all"),
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
	range: z.enum(ADMIN_STATS_RANGES).default("7d"),
});

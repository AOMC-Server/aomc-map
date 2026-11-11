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

export const createDimensionSchema = z.object({
	slug: slugSchema,
	name: z.string().trim().min(1).max(100),
	scale: dimensionScaleSchema.optional(),
});

export const updateDimensionSchema = z
	.object({
		name: z.string().trim().min(1).max(100).optional(),
		sortOrder: z.number().int().optional(),
		archived: z.boolean().optional(),
		scale: dimensionScaleSchema.optional(),
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
});

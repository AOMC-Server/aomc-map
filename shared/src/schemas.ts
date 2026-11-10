import { z } from "zod";

export const roleSchema = z.enum(["viewer", "editor", "moderator", "owner"]);
export type Role = z.infer<typeof roleSchema>;

export const visibilitySchema = z.enum(["public", "private"]);
export type Visibility = z.infer<typeof visibilitySchema>;

const slugSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _ only");

export const createMapSchema = z.object({
	slug: slugSchema,
	name: z.string().trim().min(1).max(100),
	visibility: visibilitySchema.default("private"),
	tileSize: z.number().int().min(16).max(2048).optional(),
});
export type CreateMap = z.infer<typeof createMapSchema>;

export const updateMapSchema = z.object({
	name: z.string().trim().min(1).max(100).optional(),
	visibility: visibilitySchema.optional(),
	tileSize: z.number().int().min(16).max(2048).optional(),
});
export type UpdateMap = z.infer<typeof updateMapSchema>;

export const createDimensionSchema = z.object({
	slug: slugSchema,
	name: z.string().trim().min(1).max(100),
});
export type CreateDimension = z.infer<typeof createDimensionSchema>;

export const updateDimensionSchema = z.object({
	name: z.string().trim().min(1).max(100).optional(),
	sortOrder: z.number().int().optional(),
	archived: z.boolean().optional(),
});
export type UpdateDimension = z.infer<typeof updateDimensionSchema>;

export const setMemberSchema = z.object({
	userId: z.string().min(1),
	role: roleSchema,
});
export type SetMember = z.infer<typeof setMemberSchema>;

export const updateMemberSchema = z.object({ role: roleSchema });

export const createTokenSchema = z.object({
	name: z.string().trim().min(1).max(100),
});

import { z } from "zod";

export const MAX_INVITE_HOURS = 24 * 365;
export const DEFAULT_INVITE_HOURS = 24 * 7;

export const layerRoleSchema = z.enum(["viewer", "editor"]);
export type LayerRole = z.infer<typeof layerRoleSchema>;

const expiry = z
	.number()
	.int()
	.min(1)
	.max(MAX_INVITE_HOURS)
	.nullable()
	.default(DEFAULT_INVITE_HOURS);
const maxUses = z.number().int().min(1).max(1000).nullable().default(null);

/** Map invites make moderators; owners are added explicitly from the members panel. */
export const createMapInviteSchema = z.object({
	expiresInHours: expiry,
	maxUses,
});

export const createLayerInviteSchema = z.object({
	role: layerRoleSchema,
	expiresInHours: expiry,
	maxUses,
});

export const layerMemberSchema = z.object({
	userId: z.string().min(1),
	role: layerRoleSchema,
});

export const layerMemberRoleSchema = z.object({ role: layerRoleSchema });

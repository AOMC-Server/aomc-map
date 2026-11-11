import { z } from "zod";

export const MAX_INVITE_HOURS = 24 * 365;
export const DEFAULT_INVITE_HOURS = 24 * 7;
export const MAX_INVITE_USES = 1000;

export const layerRoleSchema = z.enum(["viewer", "editor"]);
export type LayerRole = z.infer<typeof layerRoleSchema>;

/** What an invite grants: a layer role, or moderator for a map invite. */
export const inviteRoleSchema = z.enum([
	...layerRoleSchema.options,
	"moderator",
]);
export type InviteRole = z.infer<typeof inviteRoleSchema>;

const expiry = z
	.number()
	.int()
	.min(1)
	.max(MAX_INVITE_HOURS)
	.nullable()
	.default(DEFAULT_INVITE_HOURS);
const maxUses = z
	.number()
	.int()
	.min(1)
	.max(MAX_INVITE_USES)
	.nullable()
	.default(null);

/** Map invites make moderators; owners are added explicitly from the members panel. */
export const createMapInviteSchema = z.object({
	expiresInHours: expiry,
	maxUses,
});

export type CreateMapInvite = z.infer<typeof createMapInviteSchema>;

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

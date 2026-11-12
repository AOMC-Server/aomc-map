import type { Role } from "./schemas";

const RANK: Record<Role, number> = {
	viewer: 0,
	editor: 1,
	moderator: 2,
	owner: 3,
};

export function atLeast(role: Role, min: Role): boolean {
	return RANK[role] >= RANK[min];
}

/** Upload, draw, create layers. */
export const canEdit = (role: Role) => atLeast(role, "editor");
/** Delete uploads, restore features, manage dimensions, see every layer. */
export const canModerate = (role: Role) => atLeast(role, "moderator");
/** Members, invites and map settings. */
export const canManage = (role: Role) => atLeast(role, "owner");

/** In maintenance mode the map is read only for everyone but owners. */
export const isReadOnly = (role: Role, maintenance: boolean) =>
	maintenance && !canManage(role);

/** Roles from highest to lowest. */
export const ROLES_DESCENDING: readonly Role[] = [
	"owner",
	"moderator",
	"editor",
	"viewer",
];

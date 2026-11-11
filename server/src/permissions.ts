import type { Role } from "@aomc/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./db/client";
import { layerMembers, layers, mapMembers, maps } from "./db/schema";

export type Actor = { id: string } | null;
export type MapInfo = { headRev: number };
export type LayerInfo = {
	visibility: "inherit" | "private";
	createdBy: string;
};
export type LayerRole = "viewer" | "editor" | null;

const RANK: Record<Role, number> = {
	viewer: 0,
	editor: 1,
	moderator: 2,
	owner: 3,
};

export function atLeast(role: Role, min: Role): boolean {
	return RANK[role] >= RANK[min];
}

/**
 * The map is public: an explicit membership wins, otherwise a logged-in user is an implicit
 * editor and an anonymous visitor a viewer. `membership` is the explicit map_members role.
 */
export function effectiveRole(actor: Actor, membership: Role | null): Role {
	if (membership) return membership;
	return actor ? "editor" : "viewer";
}

export const canUpload = (role: Role) => atLeast(role, "editor");
export const canEditFeatures = (role: Role) => atLeast(role, "editor");
export const canCreateLayers = (role: Role) => atLeast(role, "editor");
export const canModerate = (role: Role) => atLeast(role, "moderator");
export const canManageMembers = (role: Role) => atLeast(role, "owner");
export const canManageSettings = (role: Role) => atLeast(role, "owner");
export const canManageInvites = (role: Role) => atLeast(role, "owner");
export const canManageDimensions = (role: Role) => atLeast(role, "moderator");

/** Tiles cannot be re-cut, so the size is only changeable until the first upload. */
export function canChangeTileSize(role: Role, map: MapInfo): boolean {
	return atLeast(role, "owner") && map.headRev === 0;
}

export function canViewLayer(
	role: Role,
	layer: LayerInfo,
	layerRole: LayerRole,
): boolean {
	if (layer.visibility === "inherit") return true;
	return canModerate(role) || layerRole !== null;
}

export function canEditLayer(
	role: Role,
	layer: LayerInfo,
	layerRole: LayerRole,
): boolean {
	if (!canEditFeatures(role)) return false;
	if (layer.visibility === "inherit") return true;
	return canModerate(role) || layerRole === "editor";
}

/** Who may add or remove the members of a private layer and hand out its invite links. */
export function canManageLayerMembers(
	actor: Actor,
	role: Role,
	layer: LayerInfo,
): boolean {
	if (canModerate(role)) return true;
	return (
		actor !== null && actor.id === layer.createdBy && canEditFeatures(role)
	);
}

export function canDeleteLayer(
	actor: Actor,
	role: Role,
	layer: LayerInfo,
): boolean {
	if (canModerate(role)) return true;
	return (
		actor !== null && actor.id === layer.createdBy && canEditFeatures(role)
	);
}

/** Whether changing `target` from `current` to `next` (null = removal) would leave the map with no owner. */
export function leavesNoOwner(
	owners: number,
	current: Role,
	next: Role | null,
): boolean {
	return current === "owner" && next !== "owner" && owners <= 1;
}

export async function loadMembership(
	db: Db,
	mapId: number,
	userId: string,
): Promise<Role | null> {
	const [row] = await db
		.select({ role: mapMembers.role })
		.from(mapMembers)
		.where(and(eq(mapMembers.mapId, mapId), eq(mapMembers.userId, userId)));
	return row?.role ?? null;
}

async function loadLayerRole(
	db: Db,
	layerId: number,
	userId: string,
): Promise<LayerRole> {
	const [row] = await db
		.select({ role: layerMembers.role })
		.from(layerMembers)
		.where(
			and(eq(layerMembers.layerId, layerId), eq(layerMembers.userId, userId)),
		);
	return row?.role ?? null;
}

async function resolveAccess(
	db: Db,
	actor: Actor,
	map: typeof maps.$inferSelect | undefined,
) {
	if (!map) return null;
	const membership = actor ? await loadMembership(db, map.id, actor.id) : null;
	return { map, role: effectiveRole(actor, membership) };
}

/** Loads a map by slug with the actor's effective role. Returns null when it doesn't exist. */
export async function loadMapAccess(db: Db, actor: Actor, slug: string) {
	const [map] = await db.select().from(maps).where(eq(maps.slug, slug));
	return resolveAccess(db, actor, map);
}

export async function loadMapAccessById(db: Db, actor: Actor, mapId: number) {
	const [map] = await db.select().from(maps).where(eq(maps.id, mapId));
	return resolveAccess(db, actor, map);
}

/** Loads a live layer the actor may view, with their map and layer roles. null means answer 404. */
export async function loadLayerAccess(db: Db, actor: Actor, layerId: number) {
	if (!Number.isSafeInteger(layerId)) return null;
	const [layer] = await db
		.select()
		.from(layers)
		.where(and(eq(layers.id, layerId), isNull(layers.deletedAt)));
	if (!layer) return null;
	const access = await loadMapAccessById(db, actor, layer.mapId);
	if (!access) return null;
	const layerRole = actor ? await loadLayerRole(db, layer.id, actor.id) : null;
	if (!canViewLayer(access.role, layer, layerRole)) return null;
	return { layer, map: access.map, role: access.role, layerRole };
}

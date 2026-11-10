import type { Role } from "@aomc/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { layerMembers, mapMembers, maps } from "./db/schema";

export type Actor = { id: string } | null;
export type MapInfo = {
	visibility: "public" | "private";
	isDefault: boolean;
	headRev: number;
};
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

export function atLeast(role: Role | null, min: Role): boolean {
	return role !== null && RANK[role] >= RANK[min];
}

/** Role after applying public-map defaults. `membership` is the explicit map_members role. */
export function effectiveRole(
	actor: Actor,
	map: MapInfo,
	membership: Role | null,
): Role | null {
	if (membership) return membership;
	if (map.visibility === "private") return null;
	return actor ? "editor" : "viewer";
}

export const canViewMap = (role: Role | null) => atLeast(role, "viewer");
export const canUpload = (role: Role | null) => atLeast(role, "editor");
export const canEditFeatures = (role: Role | null) => atLeast(role, "editor");
export const canCreateLayers = (role: Role | null) => atLeast(role, "editor");
export const canModerate = (role: Role | null) => atLeast(role, "moderator");
export const canManageMembers = (role: Role | null) => atLeast(role, "owner");
export const canManageSettings = (role: Role | null) => atLeast(role, "owner");
export const canDeleteMap = (role: Role | null) => atLeast(role, "owner");

export function canManageDimensions(role: Role | null, map: MapInfo): boolean {
	return (
		atLeast(role, "owner") || (map.isDefault && atLeast(role, "moderator"))
	);
}

export function canChangeTileSize(role: Role | null, map: MapInfo): boolean {
	return atLeast(role, "owner") && map.headRev === 0;
}

export function canViewLayer(
	role: Role | null,
	layer: LayerInfo,
	layerRole: LayerRole,
): boolean {
	if (!canViewMap(role)) return false;
	if (layer.visibility === "inherit") return true;
	return canModerate(role) || layerRole !== null;
}

export function canEditLayer(
	role: Role | null,
	layer: LayerInfo,
	layerRole: LayerRole,
): boolean {
	if (!canEditFeatures(role)) return false;
	if (layer.visibility === "inherit") return true;
	return canModerate(role) || layerRole === "editor";
}

export function canDeleteLayer(
	actor: Actor,
	role: Role | null,
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

export async function loadLayerRole(
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

/** Loads a map by slug with the actor's effective role. Returns null when it doesn't exist or isn't visible (callers answer 404). */
export async function loadMapAccess(db: Db, actor: Actor, slug: string) {
	const [map] = await db.select().from(maps).where(eq(maps.slug, slug));
	if (!map) return null;
	const membership = actor ? await loadMembership(db, map.id, actor.id) : null;
	const role = effectiveRole(actor, map, membership);
	if (!canViewMap(role)) return null;
	return { map, role: role as Role };
}

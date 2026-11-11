import {
	atLeast,
	canEdit,
	canManage,
	canModerate,
	type LayerRole,
	type Role,
} from "@aomc/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./db/client";
import { layerMembers, layers, mapInfo, members } from "./db/schema";

export { atLeast, canEdit, canManage, canModerate };

export type Actor = { id: string } | null;
export type LayerInfo = {
	visibility: "public" | "private";
	createdBy: string;
};
/** A layer role, or null for no access of their own. */
export type LayerAccess = LayerRole | null;

/**
 * The map is public: an explicit membership wins, otherwise a logged-in user is an editor and
 * an anonymous visitor a viewer.
 */
export function effectiveRole(actor: Actor, membership: Role | null): Role {
	if (membership) return membership;
	return actor ? "editor" : "viewer";
}

/**
 * Delete an upload: moderators any, editors their own for `windowMs` after uploading it.
 */
export function canDeleteUpload(
	actor: Actor,
	role: Role,
	upload: { authorId: string; createdAt: number },
	windowMs: number,
	now = Date.now(),
): boolean {
	if (canModerate(role)) return true;
	return (
		actor !== null &&
		canEdit(role) &&
		actor.id === upload.authorId &&
		now - upload.createdAt < windowMs
	);
}

/** The actor's role on a layer: an explicit membership, else editor for its creator. */
export function effectiveLayerRole(
	actor: Actor,
	layer: LayerInfo,
	membership: LayerAccess,
): LayerAccess {
	if (membership) return membership;
	return actor !== null && actor.id === layer.createdBy ? "editor" : null;
}

export function canViewLayer(
	role: Role,
	layer: LayerInfo,
	layerRole: LayerAccess,
): boolean {
	if (layer.visibility === "public") return true;
	return canModerate(role) || layerRole !== null;
}

export function canEditLayer(
	role: Role,
	layer: LayerInfo,
	layerRole: LayerAccess,
): boolean {
	if (!canEdit(role)) return false;
	if (layer.visibility === "public") return true;
	return canModerate(role) || layerRole === "editor";
}

/** Delete a layer, change its visibility, and manage its members and invite links. */
export function canManageLayer(
	actor: Actor,
	role: Role,
	layer: LayerInfo,
): boolean {
	if (canModerate(role)) return true;
	return actor !== null && actor.id === layer.createdBy && canEdit(role);
}

/** Whether changing a member from `current` to `next` (null = removal) would leave no owner. */
export function leavesNoOwner(
	owners: number,
	current: Role,
	next: Role | null,
): boolean {
	return current === "owner" && next !== "owner" && owners <= 1;
}

export async function loadMap(db: Db) {
	const map = await db.select().from(mapInfo).get();
	if (!map) throw new Error("map has not been set up");
	return map;
}

/** The map and the actor's effective role on it. */
export async function loadAccess(db: Db, actor: Actor) {
	const map = await loadMap(db);
	const row = actor
		? await db
				.select({ role: members.role })
				.from(members)
				.where(eq(members.userId, actor.id))
				.get()
		: undefined;
	return { map, role: effectiveRole(actor, row?.role ?? null) };
}

/** Loads a live layer the actor may view, with their role on it. null means answer 404. */
export async function loadLayerAccess(
	db: Db,
	actor: Actor,
	role: Role,
	layerId: number,
) {
	if (!Number.isSafeInteger(layerId)) return null;
	const [layer] = await db
		.select()
		.from(layers)
		.where(and(eq(layers.id, layerId), isNull(layers.deletedAt)));
	if (!layer) return null;
	const row = actor
		? await db
				.select({ role: layerMembers.role })
				.from(layerMembers)
				.where(
					and(
						eq(layerMembers.layerId, layer.id),
						eq(layerMembers.userId, actor.id),
					),
				)
				.get()
		: undefined;
	const layerRole = effectiveLayerRole(actor, layer, row?.role ?? null);
	if (!canViewLayer(role, layer, layerRole)) return null;
	return { layer, layerRole };
}

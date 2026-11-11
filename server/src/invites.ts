import type { Role } from "@aomc/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomToken, sha256Hex } from "./auth/tokens";
import type { Db } from "./db/client";
import { invites, layerMembers, layers, mapMembers, maps } from "./db/schema";
import { atLeast, effectiveRole } from "./permissions";

export const INVITE_PREFIX = "inv_";
export type InviteStatus = "active" | "revoked" | "expired" | "exhausted";

export const looksLikeInviteToken = (value: string) =>
	value.startsWith(INVITE_PREFIX) && value.length >= 20 && value.length <= 80;

export function inviteStatus(
	inv: {
		revoked: boolean;
		expiresAt: number | null;
		maxUses: number | null;
		uses: number;
	},
	now = Date.now(),
): InviteStatus {
	if (inv.revoked) return "revoked";
	if (inv.expiresAt !== null && inv.expiresAt <= now) return "expired";
	if (inv.maxUses !== null && inv.uses >= inv.maxUses) return "exhausted";
	return "active";
}

/** Returns the plaintext token once; only its hash is stored. */
export function createInvite(
	db: Db,
	opts: {
		mapId?: number;
		layerId?: number;
		role: string;
		createdBy: string;
		expiresInHours: number | null;
		maxUses: number | null;
	},
) {
	const token = INVITE_PREFIX + randomToken(24);
	const row = db
		.insert(invites)
		.values({
			tokenHash: sha256Hex(token),
			mapId: opts.mapId ?? null,
			layerId: opts.layerId ?? null,
			role: opts.role,
			createdBy: opts.createdBy,
			expiresAt:
				opts.expiresInHours === null
					? null
					: Date.now() + opts.expiresInHours * 3_600_000,
			maxUses: opts.maxUses,
		})
		.returning()
		.get();
	return { row, token };
}

export type AcceptResult =
	| {
			ok: true;
			kind: "map" | "layer";
			mapSlug: string;
			role: string;
			alreadyMember: boolean;
	  }
	| { ok: false; status: 404 | 409 | 410; error: string };

/**
 * Applies an invite to a user in one transaction. A use is only consumed when the invite actually
 * changes something: people who already have at least that access are told so and left alone.
 */
export function acceptInvite(
	db: Db,
	userId: string,
	token: string,
): AcceptResult {
	return db.transaction((tx): AcceptResult => {
		const inv = tx
			.select()
			.from(invites)
			.where(eq(invites.tokenHash, sha256Hex(token)))
			.get();
		if (!inv) return { ok: false, status: 404, error: "invite not found" };
		const status = inviteStatus(inv);
		if (status !== "active")
			return { ok: false, status: 410, error: `this invite is ${status}` };

		const layer = inv.layerId
			? tx
					.select()
					.from(layers)
					.where(and(eq(layers.id, inv.layerId), isNull(layers.deletedAt)))
					.get()
			: undefined;
		if (inv.layerId && !layer)
			return { ok: false, status: 404, error: "that layer no longer exists" };

		const mapId = inv.mapId ?? (layer as typeof layers.$inferSelect).mapId;
		const map = tx.select().from(maps).where(eq(maps.id, mapId)).get();
		if (!map)
			return { ok: false, status: 404, error: "that map no longer exists" };

		const membership =
			tx
				.select({ role: mapMembers.role })
				.from(mapMembers)
				.where(and(eq(mapMembers.mapId, map.id), eq(mapMembers.userId, userId)))
				.get()?.role ?? null;
		// On a public map everyone is already an editor, so a lower role changes nothing.
		const current = effectiveRole({ id: userId }, map, membership);
		const consume = () =>
			tx
				.update(invites)
				.set({ uses: sql`${invites.uses} + 1` })
				.where(eq(invites.id, inv.id))
				.run();

		if (!layer) {
			const role = inv.role as Role;
			if (atLeast(current, role)) {
				return {
					ok: true,
					kind: "map",
					mapSlug: map.slug,
					role: current as Role,
					alreadyMember: true,
				};
			}
			tx.insert(mapMembers)
				.values({ mapId: map.id, userId, role, addedBy: inv.createdBy })
				.onConflictDoUpdate({
					target: [mapMembers.mapId, mapMembers.userId],
					set: { role },
				})
				.run();
			consume();
			return {
				ok: true,
				kind: "map",
				mapSlug: map.slug,
				role,
				alreadyMember: false,
			};
		}

		// A layer invite never opens up a private map by itself; the map owner decides that.
		if (current === null) {
			return {
				ok: false,
				status: 409,
				error:
					"You need access to this map first. Ask the map owner to invite you to it.",
			};
		}
		const role = inv.role as "viewer" | "editor";
		const existing = tx
			.select({ role: layerMembers.role })
			.from(layerMembers)
			.where(
				and(
					eq(layerMembers.layerId, layer.id),
					eq(layerMembers.userId, userId),
				),
			)
			.get()?.role;
		if (existing === "editor" || existing === role) {
			return {
				ok: true,
				kind: "layer",
				mapSlug: map.slug,
				role: existing,
				alreadyMember: true,
			};
		}
		tx.insert(layerMembers)
			.values({ layerId: layer.id, userId, role })
			.onConflictDoUpdate({
				target: [layerMembers.layerId, layerMembers.userId],
				set: { role },
			})
			.run();
		consume();
		return {
			ok: true,
			kind: "layer",
			mapSlug: map.slug,
			role,
			alreadyMember: false,
		};
	});
}

import { HOUR, type LayerRole, type MemberRole, type Role } from "@aomc/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomToken, sha256Hex } from "./auth/tokens";
import type { Db } from "./db/client";
import { invites, layerMembers, layers, members } from "./db/schema";
import {
	atLeast,
	canManage,
	canManageLayer,
	effectiveLayerRole,
	effectiveRole,
} from "./permissions";

const INVITE_PREFIX = "inv_";
/** What a map invite makes the person; owners are only ever added from the members panel. */
export const MAP_INVITE_ROLE = "moderator" as const;

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

/**
 * Returns the plaintext token once; only its hash is stored. A map invite always grants
 * MAP_INVITE_ROLE.
 */
export function createInvite(
	db: Db,
	opts: ({ layerId: null } | { layerId: number; role: LayerRole }) & {
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
			layerId: opts.layerId,
			role: opts.layerId === null ? MAP_INVITE_ROLE : opts.role,
			createdBy: opts.createdBy,
			expiresAt:
				opts.expiresInHours === null
					? null
					: Date.now() + opts.expiresInHours * HOUR,
			maxUses: opts.maxUses,
		})
		.returning()
		.get();
	return { row, token };
}

type InviteRow = typeof invites.$inferSelect;
type LayerRow = typeof layers.$inferSelect;
type Reader = Pick<Db, "select">;

export type ResolvedInvite =
	| { ok: true; inv: InviteRow; layer: LayerRow | null }
	| {
			ok: false;
			status: 404 | 410;
			error: string;
			reason?: InviteStatus | "gone";
	  };

/**
 * Finds an invite by token and checks it can still be used: it is active, its layer exists, and
 * whoever made it still has the right to (a demoted owner's links stop working).
 */
export function resolveInvite(db: Reader, token: string): ResolvedInvite {
	const inv = db
		.select()
		.from(invites)
		.where(eq(invites.tokenHash, sha256Hex(token)))
		.get();
	if (!inv) return { ok: false, status: 404, error: "invite not found" };
	const status = inviteStatus(inv);
	if (status !== "active") {
		return {
			ok: false,
			status: 410,
			error: `this invite is ${status}`,
			reason: status,
		};
	}
	const gone = {
		ok: false,
		status: 410,
		error: "this invite is no longer valid",
		reason: "gone",
	} as const;

	const layer =
		inv.layerId === null
			? null
			: (db
					.select()
					.from(layers)
					.where(and(eq(layers.id, inv.layerId), isNull(layers.deletedAt)))
					.get() ?? null);
	if (inv.layerId !== null && !layer) return gone;

	const creator = { id: inv.createdBy };
	const creatorRole = effectiveRole(creator, memberRole(db, inv.createdBy));
	const allowed = layer
		? canManageLayer(creator, creatorRole, layer)
		: canManage(creatorRole);
	return allowed ? { ok: true, inv, layer } : gone;
}

function memberRole(db: Reader, userId: string) {
	return (
		db
			.select({ role: members.role })
			.from(members)
			.where(eq(members.userId, userId))
			.get()?.role ?? null
	);
}

/** The user's current role if it already covers what the invite would give; null if it would add something. */
export function coveredBy(
	db: Reader,
	userId: string,
	{ inv, layer }: { inv: InviteRow; layer: LayerRow | null },
): Role | null {
	const actor = { id: userId };
	if (!layer) {
		const current = effectiveRole(actor, memberRole(db, userId));
		return atLeast(current, inv.role as Role) ? current : null;
	}
	const existing = db
		.select({ role: layerMembers.role })
		.from(layerMembers)
		.where(
			and(eq(layerMembers.layerId, layer.id), eq(layerMembers.userId, userId)),
		)
		.get()?.role;
	const current = effectiveLayerRole(actor, layer, existing ?? null);
	return current === "editor" || current === inv.role ? current : null;
}

export type AcceptResult =
	| {
			ok: true;
			kind: "map" | "layer";
			role: string;
			alreadyMember: boolean;
			/** Set when a layer invite changed access: the layer's dimension. */
			layerDimensionId?: number;
	  }
	| { ok: false; status: 403 | 404 | 410; error: string };

/**
 * Applies an invite to a user in one transaction. A use is only consumed when the invite actually
 * changes something: people who already have at least that access are told so and left alone.
 * `allowMap` is false for callers that must not be handed map powers (feature-only API tokens).
 */
export function acceptInvite(
	db: Db,
	userId: string,
	token: string,
	allowMap = true,
): AcceptResult {
	return db.transaction((tx): AcceptResult => {
		const found = resolveInvite(tx, token);
		if (!found.ok) return found;
		const { inv, layer } = found;
		if (!layer && !allowMap) {
			return {
				ok: false,
				status: 403,
				error: "accepting a map invite needs a browser session",
			};
		}

		const kind = layer ? "layer" : "map";
		const covered = coveredBy(tx, userId, found);
		if (covered) {
			return { ok: true, kind, role: covered, alreadyMember: true };
		}

		if (layer) {
			const role = inv.role as LayerRole;
			tx.insert(layerMembers)
				.values({ layerId: layer.id, userId, role })
				.onConflictDoUpdate({
					target: [layerMembers.layerId, layerMembers.userId],
					set: { role },
				})
				.run();
		} else {
			const role = inv.role as MemberRole;
			tx.insert(members)
				.values({ userId, role })
				.onConflictDoUpdate({ target: members.userId, set: { role } })
				.run();
		}
		tx.update(invites)
			.set({ uses: sql`${invites.uses} + 1` })
			.where(eq(invites.id, inv.id))
			.run();
		return {
			ok: true,
			kind,
			role: inv.role,
			alreadyMember: false,
			...(layer && { layerDimensionId: layer.dimensionId }),
		};
	});
}

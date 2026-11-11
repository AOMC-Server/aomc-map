import { and, eq, isNull, sql } from "drizzle-orm";
import { randomToken, sha256Hex } from "./auth/tokens";
import type { Db } from "./db/client";
import { invites, layerMembers, layers, members } from "./db/schema";
import { atLeast, effectiveRole } from "./permissions";

const INVITE_PREFIX = "inv_";
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

/** Returns the plaintext token once; only its hash is stored. layerId null makes a map invite. */
export function createInvite(
	db: Db,
	opts: {
		layerId: number | null;
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
			layerId: opts.layerId,
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
			role: string;
			alreadyMember: boolean;
	  }
	| { ok: false; status: 404 | 410; error: string };

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

		const consume = () =>
			tx
				.update(invites)
				.set({ uses: sql`${invites.uses} + 1` })
				.where(eq(invites.id, inv.id))
				.run();

		if (inv.layerId === null) {
			const membership = tx
				.select({ role: members.role })
				.from(members)
				.where(eq(members.userId, userId))
				.get();
			const current = effectiveRole({ id: userId }, membership?.role ?? null);
			if (atLeast(current, "moderator")) {
				return { ok: true, kind: "map", role: current, alreadyMember: true };
			}
			tx.insert(members)
				.values({ userId, role: "moderator" })
				.onConflictDoUpdate({
					target: members.userId,
					set: { role: "moderator" },
				})
				.run();
			consume();
			return {
				ok: true,
				kind: "map",
				role: "moderator",
				alreadyMember: false,
			};
		}

		const layer = tx
			.select({ id: layers.id })
			.from(layers)
			.where(and(eq(layers.id, inv.layerId), isNull(layers.deletedAt)))
			.get();
		if (!layer)
			return { ok: false, status: 404, error: "that layer no longer exists" };

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
			return { ok: true, kind: "layer", role: existing, alreadyMember: true };
		}
		tx.insert(layerMembers)
			.values({ layerId: layer.id, userId, role })
			.onConflictDoUpdate({
				target: [layerMembers.layerId, layerMembers.userId],
				set: { role },
			})
			.run();
		consume();
		return { ok: true, kind: "layer", role, alreadyMember: false };
	});
}

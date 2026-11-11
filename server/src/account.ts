import { count, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import {
	apiTokens,
	dimensions,
	featureRevisions,
	invites,
	layerMembers,
	layers,
	members,
	revisions,
	sessions,
	shortLinks,
	users,
} from "./db/schema";
import { leavesNoOwner } from "./permissions";

/** The name shown for contributions of someone who deleted their account. */
export const DELETED_USER_NAME = "Deleted user";

/** Everything stored about a user, for them to download (GDPR right of access). */
export function exportAccount(db: Db, userId: string) {
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) return null;
	const dimensionSlug = new Map(
		db
			.select({ id: dimensions.id, slug: dimensions.slug })
			.from(dimensions)
			.all()
			.map((d) => [d.id, d.slug]),
	);
	const slugOf = (id: number | null) =>
		id === null ? null : (dimensionSlug.get(id) ?? null);

	return {
		exportedAt: new Date().toISOString(),
		account: {
			discordId: user.id,
			username: user.username,
			avatarUrl: user.avatarUrl,
			createdAt: user.createdAt,
			lastLoginAt: user.lastLoginAt,
		},
		mapRole:
			db
				.select({ role: members.role, since: members.createdAt })
				.from(members)
				.where(eq(members.userId, userId))
				.get() ?? null,
		sessions: db
			.select({ expiresAt: sessions.expiresAt })
			.from(sessions)
			.where(eq(sessions.userId, userId))
			.all(),
		apiTokens: db
			.select({
				name: apiTokens.name,
				scopes: apiTokens.scopes,
				createdAt: apiTokens.createdAt,
				lastUsedAt: apiTokens.lastUsedAt,
				expiresAt: apiTokens.expiresAt,
			})
			.from(apiTokens)
			.where(eq(apiTokens.userId, userId))
			.all(),
		uploads: db
			.select()
			.from(revisions)
			.where(eq(revisions.authorId, userId))
			.all()
			.map(({ authorId: _, dimensionId, ...r }) => ({
				...r,
				dimension: slugOf(dimensionId),
			})),
		layersCreated: db
			.select()
			.from(layers)
			.where(eq(layers.createdBy, userId))
			.all()
			.map(({ createdBy: _, dimensionId, ...l }) => ({
				...l,
				dimension: slugOf(dimensionId),
			})),
		layerMemberships: db
			.select({ layerId: layerMembers.layerId, role: layerMembers.role })
			.from(layerMembers)
			.where(eq(layerMembers.userId, userId))
			.all(),
		featureEdits: db
			.select()
			.from(featureRevisions)
			.where(eq(featureRevisions.authorId, userId))
			.all()
			.map(({ authorId: _, ...f }) => f),
		invitesCreated: db
			.select({
				id: invites.id,
				layerId: invites.layerId,
				role: invites.role,
				expiresAt: invites.expiresAt,
				maxUses: invites.maxUses,
				uses: invites.uses,
				revoked: invites.revoked,
			})
			.from(invites)
			.where(eq(invites.createdBy, userId))
			.all(),
		shortLinks: db
			.select({
				code: shortLinks.code,
				query: shortLinks.query,
				createdAt: shortLinks.createdAt,
			})
			.from(shortLinks)
			.where(eq(shortLinks.createdBy, userId))
			.all(),
	};
}

export type DeleteResult = "deleted" | "missing" | "last owner";

/**
 * Deletes an account. The login, sessions, tokens, roles, layer memberships and the invites the
 * user made go away. What they added to the map (uploads, layers, features and their history)
 * stays, because others build on it, but is moved to a new placeholder user named "Deleted
 * user" that carries nothing of theirs: no Discord id, name or avatar. Their short links are
 * kept without a creator.
 */
export function deleteAccount(db: Db, userId: string): DeleteResult {
	return db.transaction(
		(tx) => {
			const user = tx
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, userId))
				.get();
			if (!user) return "missing";

			const role = tx
				.select({ role: members.role })
				.from(members)
				.where(eq(members.userId, userId))
				.get()?.role;
			if (role) {
				const owners =
					tx
						.select({ n: count() })
						.from(members)
						.where(eq(members.role, "owner"))
						.get()?.n ?? 0;
				if (leavesNoOwner(owners, role, null)) return "last owner";
			}

			const placeholder = `deleted-${crypto.randomUUID()}`;
			const now = Date.now();
			tx.insert(users)
				.values({
					id: placeholder,
					username: DELETED_USER_NAME,
					avatarUrl: null,
					createdAt: now,
					lastLoginAt: now,
				})
				.run();
			tx.update(revisions)
				.set({ authorId: placeholder })
				.where(eq(revisions.authorId, userId))
				.run();
			tx.update(layers)
				.set({ createdBy: placeholder })
				.where(eq(layers.createdBy, userId))
				.run();
			tx.update(featureRevisions)
				.set({ authorId: placeholder })
				.where(eq(featureRevisions.authorId, userId))
				.run();
			tx.update(shortLinks)
				.set({ createdBy: null })
				.where(eq(shortLinks.createdBy, userId))
				.run();
			tx.delete(invites).where(eq(invites.createdBy, userId)).run();
			// Sessions, tokens, the map role and layer memberships go with the row.
			tx.delete(users).where(eq(users.id, userId)).run();
			return "deleted";
		},
		{ behavior: "immediate" },
	);
}

import { featureInputSchema, featurePatchSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { Db } from "../db/client";
import { featureRevisions, features, users } from "../db/schema";
import {
	insertRevision,
	latestRevision,
	type RevisionContent,
} from "../features";
import type { Actor } from "../permissions";
import { canEditLayer, canModerate, loadLayerAccess } from "../permissions";
import type { AppEnv } from "../types";

const parseId = (value: string | undefined) =>
	/^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;

async function loadFeatureAccess(db: Db, actor: Actor, featureId: number) {
	if (!Number.isSafeInteger(featureId)) return null;
	const [feature] = await db
		.select()
		.from(features)
		.where(eq(features.id, featureId));
	if (!feature) return null;
	const found = await loadLayerAccess(db, actor, feature.layerId);
	return found && { feature, ...found };
}

type Revision = typeof featureRevisions.$inferSelect;

function serialize(feature: { id: number; layerId: number }, r: Revision) {
	return {
		id: feature.id,
		layerId: feature.layerId,
		revisionId: r.id,
		type: r.type,
		name: r.name,
		popup: r.popup,
		color: r.color,
		geometry: r.geometry,
		authorId: r.authorId,
		updatedAt: r.createdAt,
	};
}

const contentOf = (r: Revision) =>
	({
		type: r.type,
		name: r.name,
		popup: r.popup,
		color: r.color,
		geometry: r.geometry,
	}) as RevisionContent;

/** /api/features */
export const featureRoutes = new Hono<AppEnv>()
	.patch(
		"/:id",
		requireUser,
		zValidator("json", featurePatchSchema),
		async (c) => {
			const { db } = c.var;
			const user = c.var.user as NonNullable<typeof c.var.user>;
			const found = await loadFeatureAccess(
				db,
				user,
				parseId(c.req.param("id")),
			);
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(found.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const current = await latestRevision(db, found.feature.id);
			if (!current || current.deleted)
				return c.json({ error: "not found" }, 404);

			const patch = c.req.valid("json");
			const merged = featureInputSchema.safeParse({
				type: patch.type ?? current.type,
				name: patch.name ?? current.name,
				popup: patch.popup ?? current.popup,
				color: patch.color === undefined ? current.color : patch.color,
				geometry: patch.geometry ?? current.geometry,
			});
			if (!merged.success)
				return c.json(
					{ error: "invalid feature", issues: merged.error.issues },
					400,
				);

			const inserted = insertRevision(
				db,
				found.feature.id,
				user.id,
				merged.data,
			);
			const [row] = await db
				.select()
				.from(featureRevisions)
				.where(eq(featureRevisions.id, inserted.id));
			return c.json({ feature: serialize(found.feature, row as Revision) });
		},
	)
	.delete("/:id", requireUser, async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadFeatureAccess(db, user, parseId(c.req.param("id")));
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canEditLayer(found.role, found.layer, found.layerRole))
			return c.json({ error: "forbidden" }, 403);

		const current = await latestRevision(db, found.feature.id);
		if (!current || current.deleted) return c.json({ error: "not found" }, 404);
		insertRevision(db, found.feature.id, user.id, {
			...contentOf(current),
			deleted: true,
		});
		return c.json({ ok: true });
	})
	.get("/:id/history", async (c) => {
		const { db } = c.var;
		const found = await loadFeatureAccess(
			db,
			c.var.user,
			parseId(c.req.param("id")),
		);
		if (!found) return c.json({ error: "not found" }, 404);
		const rows = await db
			.select({ revision: featureRevisions, authorName: users.username })
			.from(featureRevisions)
			.innerJoin(users, eq(users.id, featureRevisions.authorId))
			.where(eq(featureRevisions.featureId, found.feature.id))
			.orderBy(desc(featureRevisions.id));
		return c.json({
			history: rows.map(({ revision: r, authorName }) => ({
				revisionId: r.id,
				authorId: r.authorId,
				authorName,
				createdAt: r.createdAt,
				deleted: r.deleted,
				type: r.type,
				name: r.name,
				popup: r.popup,
				color: r.color,
				geometry: r.geometry,
			})),
		});
	})
	.post("/:id/restore/:revisionId", requireUser, async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadFeatureAccess(db, user, parseId(c.req.param("id")));
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canModerate(found.role)) return c.json({ error: "forbidden" }, 403);

		const [old] = await db
			.select()
			.from(featureRevisions)
			.where(
				and(
					eq(featureRevisions.id, parseId(c.req.param("revisionId"))),
					eq(featureRevisions.featureId, found.feature.id),
				),
			);
		if (!old) return c.json({ error: "revision not found" }, 404);

		const inserted = insertRevision(db, found.feature.id, user.id, {
			...contentOf(old),
			deleted: old.deleted,
		});
		const [row] = await db
			.select()
			.from(featureRevisions)
			.where(eq(featureRevisions.id, inserted.id));
		return c.json(
			{
				feature: serialize(found.feature, row as Revision),
				deleted: old.deleted,
			},
			201,
		);
	});

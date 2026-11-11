import type { Role } from "@aomc/shared";
import { featureInputSchema, featurePatchSchema } from "@aomc/shared";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { featureRevisions, features, users } from "../db/schema";
import { contentOf, insertRevision, latestRevision, toView } from "../features";
import { doc } from "../openapi";
import {
	type Actor,
	canEditLayer,
	canModerate,
	loadLayerAccess,
} from "../permissions";
import type { AppEnv } from "../types";
import { parseId } from "./util";

async function loadFeatureAccess(
	db: Db,
	actor: Actor,
	role: Role,
	featureId: number,
) {
	if (!Number.isSafeInteger(featureId)) return null;
	const [feature] = await db
		.select()
		.from(features)
		.where(eq(features.id, featureId));
	if (!feature) return null;
	const found = await loadLayerAccess(db, actor, role, feature.layerId);
	return found && { feature, ...found };
}

export const featureRoutes = new Hono<AppEnv>()
	.patch(
		"/:id",
		doc({
			tag: "Features",
			summary: "Update a feature",
			fails: [400, 403, 404],
			login: true,
		}),
		requireUser,
		validator("json", featurePatchSchema),
		async (c) => {
			const { db, role } = c.var;
			const user = userOf(c);
			const found = await loadFeatureAccess(
				db,
				user,
				role,
				parseId(c.req.param("id")),
			);
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(role, found.layer, found.layerRole))
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

			const row = insertRevision(db, found.feature.id, user.id, merged.data);
			return c.json({ feature: toView(found.feature, row) });
		},
	)
	.delete(
		"/:id",
		doc({
			tag: "Features",
			summary: "Delete a feature",
			description: "Recorded as a new revision, so it can be restored.",
			fails: [403, 404],
			login: true,
		}),
		requireUser,
		async (c) => {
			const { db, role } = c.var;
			const user = userOf(c);
			const found = await loadFeatureAccess(
				db,
				user,
				role,
				parseId(c.req.param("id")),
			);
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const current = await latestRevision(db, found.feature.id);
			if (!current || current.deleted)
				return c.json({ error: "not found" }, 404);
			insertRevision(db, found.feature.id, user.id, {
				...contentOf(current),
				deleted: true,
			});
			return c.json({ ok: true });
		},
	)
	.get(
		"/:id/history",
		doc({
			tag: "Features",
			summary: "Get a feature's edit history",
			fails: [404],
		}),
		async (c) => {
			const { db } = c.var;
			const found = await loadFeatureAccess(
				db,
				c.var.user,
				c.var.role,
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
					...contentOf(r),
					revisionId: r.id,
					authorId: r.authorId,
					authorName,
					createdAt: r.createdAt,
					deleted: r.deleted,
				})),
			});
		},
	)
	.post(
		"/:id/restore/:revisionId",
		doc({
			tag: "Features",
			summary: "Restore an earlier version of a feature",
			description: "Moderators. Also brings back a deleted feature.",
			ok: { 201: "Restored" },
			fails: [403, 404],
			login: true,
		}),
		requireUser,
		async (c) => {
			const { db, role } = c.var;
			const user = userOf(c);
			const found = await loadFeatureAccess(
				db,
				user,
				role,
				parseId(c.req.param("id")),
			);
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canModerate(role)) return c.json({ error: "forbidden" }, 403);

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

			const row = insertRevision(db, found.feature.id, user.id, {
				...contentOf(old),
				deleted: old.deleted,
			});
			return c.json(
				{ feature: toView(found.feature, row), deleted: old.deleted },
				201,
			);
		},
	);

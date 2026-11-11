import type { Role } from "@aomc/shared";
import {
	featureHistoryQuerySchema,
	featureInputSchema,
	featurePatchSchema,
	MAX_FEATURES_PER_LAYER,
} from "@aomc/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { featureRevisions, features, users } from "../db/schema";
import {
	contentOf,
	insertRevision,
	latestRevision,
	liveFeatureCount,
	toView,
} from "../features";
import { doc } from "../openapi";
import {
	type Actor,
	canEditLayer,
	canModerate,
	loadLayerAccess,
} from "../permissions";
import type { AppEnv } from "../types";
import { formatIssues, validate } from "../validate";
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

type Vars = { db: Db; user: Actor; role: Role };

/** The feature as the actor sees it, or the status to answer with. */
async function viewable(v: Vars, id: string | undefined) {
	return (await loadFeatureAccess(v.db, v.user, v.role, parseId(id))) ?? 404;
}

/** Like `viewable`, for someone who is going to change the feature. */
async function editable(v: Vars, id: string | undefined) {
	const found = await viewable(v, id);
	if (found === 404) return found;
	return canEditLayer(v.role, found.layer, found.layerRole) ? found : 403;
}

const failure = { 403: "forbidden", 404: "not found" } as const;

export const featureRoutes = new Hono<AppEnv>()
	.patch(
		"/:id",
		doc({
			tag: "Features",
			summary: "Update a feature",
			description:
				"Send `baseRevisionId` (the `revisionId` you last saw) to avoid overwriting someone else's change: if the feature has a newer revision the answer is 409 with `{ error, feature }`, the current state.",
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		requireUser,
		validate("json", featurePatchSchema),
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await editable(c.var, c.req.param("id"));
			if (typeof found === "number")
				return c.json({ error: failure[found] }, found);

			const { baseRevisionId, ...patch } = c.req.valid("json");
			const out = db.transaction((tx) => {
				const current = latestRevision(tx, found.feature.id);
				if (!current || current.deleted) return { status: 404 } as const;
				if (baseRevisionId !== undefined && baseRevisionId !== current.id)
					return { status: 409, current } as const;
				const merged = featureInputSchema.safeParse({
					type: patch.type ?? current.type,
					name: patch.name ?? current.name,
					popup: patch.popup ?? current.popup,
					color: patch.color === undefined ? current.color : patch.color,
					geometry: patch.geometry ?? current.geometry,
				});
				if (!merged.success)
					return { status: 400, error: merged.error } as const;
				return {
					status: 200,
					row: insertRevision(tx, found.feature.id, user.id, merged.data),
				} as const;
			});
			switch (out.status) {
				case 404:
					return c.json({ error: "not found" }, 404);
				case 409:
					return c.json(
						{
							error: "the feature was changed since you loaded it",
							feature: toView(found.feature, out.current),
						},
						409,
					);
				case 400:
					return c.json(
						{
							error: "invalid feature",
							issues: formatIssues(out.error.issues),
						},
						400,
					);
				default:
					return c.json({ feature: toView(found.feature, out.row) });
			}
		},
	)
	.delete(
		"/:id",
		doc({
			tag: "Features",
			summary: "Delete a feature",
			description: "Recorded as a new revision, so it can be restored.",
			fails: [403, 404, 429],
			login: true,
		}),
		requireUser,
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await editable(c.var, c.req.param("id"));
			if (typeof found === "number")
				return c.json({ error: failure[found] }, found);

			const deleted = db.transaction((tx) => {
				const current = latestRevision(tx, found.feature.id);
				if (!current || current.deleted) return false;
				insertRevision(tx, found.feature.id, user.id, {
					...contentOf(current),
					deleted: true,
				});
				return true;
			});
			return deleted
				? c.json({ ok: true })
				: c.json({ error: "not found" }, 404);
		},
	)
	.get(
		"/:id/history",
		doc({
			tag: "Features",
			summary: "Get a feature's edit history",
			description:
				"Newest first, `limit` (default 50) at a time. `nextBefore` is set when there are older entries: pass it as `before` to get the next page.",
			fails: [400, 404],
		}),
		// Optional so that clients written before paging need not send a query.
		validate("query", featureHistoryQuerySchema.optional()),
		async (c) => {
			const { db } = c.var;
			const found = await viewable(c.var, c.req.param("id"));
			if (typeof found === "number")
				return c.json({ error: failure[found] }, found);

			const { limit, before } =
				c.req.valid("query") ?? featureHistoryQuerySchema.parse({});
			const rows = await db
				.select({ revision: featureRevisions, authorName: users.username })
				.from(featureRevisions)
				.innerJoin(users, eq(users.id, featureRevisions.authorId))
				.where(
					and(
						eq(featureRevisions.featureId, found.feature.id),
						before === undefined ? undefined : lt(featureRevisions.id, before),
					),
				)
				.orderBy(desc(featureRevisions.id))
				.limit(limit + 1);
			const page = rows.slice(0, limit);
			return c.json({
				history: page.map(({ revision: r, authorName }) => ({
					...contentOf(r),
					revisionId: r.id,
					authorId: r.authorId,
					authorName,
					createdAt: r.createdAt,
					deleted: r.deleted,
				})),
				nextBefore:
					rows.length > limit ? (page.at(-1)?.revision.id ?? null) : null,
			});
		},
	)
	.post(
		"/:id/restore/:revisionId",
		doc({
			tag: "Features",
			summary: "Restore an earlier version of a feature",
			description:
				"Moderators. Also brings back a deleted feature. Restoring the current version changes nothing (200).",
			ok: { 201: "Restored" },
			fails: [403, 404, 409, 429],
			login: true,
		}),
		requireUser,
		async (c) => {
			const { db, role } = c.var;
			const user = userOf(c);
			const found = await viewable(c.var, c.req.param("id"));
			if (typeof found === "number")
				return c.json({ error: failure[found] }, found);
			if (!canModerate(role)) return c.json({ error: "forbidden" }, 403);

			const revisionId = parseId(c.req.param("revisionId"));
			const out = db.transaction((tx) => {
				const old = tx
					.select()
					.from(featureRevisions)
					.where(
						and(
							eq(featureRevisions.id, revisionId),
							eq(featureRevisions.featureId, found.feature.id),
						),
					)
					.get();
				if (!old) return { status: 404 } as const;
				const current = latestRevision(tx, found.feature.id);
				if (current?.id === old.id)
					return { status: 200, row: old, old } as const;
				if (
					current?.deleted &&
					!old.deleted &&
					liveFeatureCount(tx, found.layer.id) >= MAX_FEATURES_PER_LAYER
				)
					return { status: 409 } as const;
				const row = insertRevision(tx, found.feature.id, user.id, {
					...contentOf(old),
					deleted: old.deleted,
				});
				return { status: 201, row, old } as const;
			});
			switch (out.status) {
				case 404:
					return c.json({ error: "revision not found" }, 404);
				case 409:
					return c.json(
						{
							error: `a layer holds at most ${MAX_FEATURES_PER_LAYER} features`,
						},
						409,
					);
				default:
					return c.json(
						{
							feature: toView(found.feature, out.row),
							deleted: out.old.deleted,
						},
						out.status,
					);
			}
		},
	);

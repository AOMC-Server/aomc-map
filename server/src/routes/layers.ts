import {
	createLayerSchema,
	featureImportSchema,
	featureInputSchema,
	MAX_FEATURES_PER_LAYER,
	MAX_LAYERS_PER_USER,
	reorderLayersSchema,
	reorderSchema,
	updateLayerSchema,
} from "@aomc/shared";
import { and, count, eq, gt, isNull, lte, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { announceLayers } from "../announce";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { features, layerMembers, layers, revisions } from "../db/schema";
import { dimensionBySlug } from "../dimensionLookup";
import {
	contentOf,
	featuresOfLayers,
	insertFeature,
	insertRevision,
	liveFeatureCount,
	nextFeatureOrder,
} from "../features";
import { doc } from "../openapi";
import { assignOrder, nextSortOrder, sameSet } from "../order";
import {
	type Actor,
	canEdit,
	canEditLayer,
	canManageLayer,
	canModerate,
	canViewLayer,
	effectiveLayerRole,
} from "../permissions";
import type { AppEnv } from "../types";
import { validate } from "../validate";
import { layerInviteRoutes } from "./invites";
import { layerMemberRoutes } from "./layerMembers";
import { layerFor } from "./util";

const layerFeatures = (db: Pick<Db, "select">, layerId: number) =>
	featuresOfLayers(db, [layerId]).get(layerId) ?? [];

type LayerRow = typeof layers.$inferSelect;
type LayerRole = ReturnType<typeof effectiveLayerRole>;

/** The actor's role on any layer: an explicit membership, else editor for the layer's creator. */
function layerRoles(db: Pick<Db, "select">, actor: Actor) {
	const memberships = actor
		? db
				.select({ layerId: layerMembers.layerId, role: layerMembers.role })
				.from(layerMembers)
				.where(eq(layerMembers.userId, actor.id))
				.all()
		: [];
	const byLayer = new Map(memberships.map((m) => [m.layerId, m.role]));
	return (layer: LayerRow): LayerRole =>
		effectiveLayerRole(actor, layer, byLayer.get(layer.id) ?? null);
}

const layerIsLive = (db: Pick<Db, "select">, id: number) =>
	db
		.select({ id: layers.id })
		.from(layers)
		.where(and(eq(layers.id, id), isNull(layers.deletedAt)))
		.get() !== undefined;

function serializeLayer(layer: LayerRow, canEdit: boolean, canManage: boolean) {
	return {
		id: layer.id,
		dimensionId: layer.dimensionId,
		name: layer.name,
		color: layer.color,
		hiddenByDefault: layer.hiddenByDefault,
		visibility: layer.visibility,
		sortOrder: layer.sortOrder,
		createdBy: layer.createdBy,
		canEdit,
		canManage,
	};
}

/**
 * Unix ms time of a revision, for "as of revision" reads. null means "now"; undefined means
 * there is no such revision (for example the upload was deleted).
 */
function timeOfRev(db: Db, headRev: number, at: number | null) {
	if (at === null || at >= headRev) return null;
	if (at <= 0) return 0;
	const row = db
		.select({ completedAt: revisions.completedAt })
		.from(revisions)
		.where(eq(revisions.rev, at))
		.get();
	return row ? row.completedAt : undefined;
}

const layersQuerySchema = z.object({
	dim: z.string().optional(),
	at: z.string().regex(/^\d+$/).optional(),
});

export const layerRoutes = new Hono<AppEnv>()
	.get(
		"/",
		doc({
			tag: "Layers",
			summary: "List layers with their features",
			description:
				"Only layers you may see. `at` reads the layers as of a revision (404 if there is no such revision).",
			fails: [400, 404],
		}),
		validate("query", layersQuerySchema),
		(c) => {
			const { db, user, map, role, readOnly } = c.var;
			const query = c.req.valid("query");
			const at = timeOfRev(
				db,
				map.headRev,
				query.at === undefined ? null : Number(query.at),
			);
			if (at === undefined) return c.json({ error: "revision not found" }, 404);

			let dimensionId: number | undefined;
			if (query.dim) {
				const dim = dimensionBySlug(db, query.dim);
				if (!dim) return c.json({ error: "dimension not found" }, 404);
				dimensionId = dim.id;
			}

			const liveAt =
				at === null
					? isNull(layers.deletedAt)
					: and(
							lte(layers.createdAt, at),
							or(isNull(layers.deletedAt), gt(layers.deletedAt, at)),
						);
			const rows = db
				.select()
				.from(layers)
				.where(
					and(
						dimensionId === undefined
							? undefined
							: eq(layers.dimensionId, dimensionId),
						liveAt,
					),
				)
				.orderBy(layers.sortOrder, layers.id)
				.all();

			const roleOn = layerRoles(db, user);
			const visible = rows.filter((l) => canViewLayer(role, l, roleOn(l)));
			const byLayer = featuresOfLayers(
				db,
				visible.map((l) => l.id),
				at,
			);
			return c.json({
				layers: visible.map((l) => ({
					...serializeLayer(
						l,
						!readOnly && canEditLayer(role, l, roleOn(l)),
						!readOnly && canManageLayer(user, role, l),
					),
					features: byLayer.get(l.id) ?? [],
				})),
			});
		},
	)
	.post(
		"/",
		doc({
			tag: "Layers",
			summary: "Create a layer",
			description: `Everyone but moderators may have at most ${MAX_LAYERS_PER_USER} layers (409 beyond that).`,
			ok: { 201: "Layer created" },
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		requireUser,
		validate("json", createLayerSchema),
		(c) => {
			const { db, role } = c.var;
			const user = userOf(c);
			if (!canEdit(role)) return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const dim = dimensionBySlug(db, body.dimension);
			if (!dim) return c.json({ error: "dimension not found" }, 404);

			const layer = db.transaction((tx) => {
				if (!canModerate(role)) {
					const mine = tx
						.select({ n: count() })
						.from(layers)
						.where(and(eq(layers.createdBy, user.id), isNull(layers.deletedAt)))
						.get();
					if ((mine?.n ?? 0) >= MAX_LAYERS_PER_USER) return null;
				}
				const existing = tx
					.select({ sortOrder: layers.sortOrder })
					.from(layers)
					.where(isNull(layers.deletedAt))
					.all();
				const row = tx
					.insert(layers)
					.values({
						dimensionId: dim.id,
						name: body.name,
						color: body.color,
						hiddenByDefault: body.hiddenByDefault,
						visibility: body.visibility,
						sortOrder: nextSortOrder(existing),
						createdBy: user.id,
					})
					.returning()
					.get();
				// The creator of a private layer keeps access to it even if they are not a moderator.
				if (row.visibility === "private") {
					tx.insert(layerMembers)
						.values({ layerId: row.id, userId: user.id, role: "editor" })
						.run();
				}
				return row;
			});
			if (!layer)
				return c.json(
					{ error: `you can have at most ${MAX_LAYERS_PER_USER} layers` },
					409,
				);
			announceLayers(c, dim.id);
			return c.json(
				{ layer: { ...serializeLayer(layer, true, true), features: [] } },
				201,
			);
		},
	)
	.post(
		"/reorder",
		doc({
			tag: "Layers",
			summary: "Reorder the layers of a dimension",
			description:
				"`ids` must be exactly the layers you can see in that dimension.",
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		requireUser,
		validate("json", reorderLayersSchema),
		(c) => {
			const { db, role } = c.var;
			const user = userOf(c);
			if (!canEdit(role)) return c.json({ error: "forbidden" }, 403);
			const body = c.req.valid("json");
			const dim = dimensionBySlug(db, body.dimension);
			if (!dim) return c.json({ error: "dimension not found" }, 404);

			const done = db.transaction((tx) => {
				const rows = tx
					.select()
					.from(layers)
					.where(and(eq(layers.dimensionId, dim.id), isNull(layers.deletedAt)))
					.all();
				const roleOn = layerRoles(tx, user);
				// Only the layers this user can see take part; the others keep their places.
				const visible = rows.filter((l) => canViewLayer(role, l, roleOn(l)));
				if (!sameSet(visible, body.ids)) return false;
				const hidden = rows.filter((l) => !visible.includes(l));
				for (const u of assignOrder(visible, body.ids, hidden))
					tx.update(layers)
						.set({ sortOrder: u.sortOrder })
						.where(eq(layers.id, u.id))
						.run();
				return true;
			});
			if (!done)
				return c.json({ error: "the list of layers is out of date" }, 409);
			announceLayers(c, dim.id);
			return c.json({ ok: true });
		},
	)
	.patch(
		"/:id",
		doc({
			tag: "Layers",
			summary: "Update a layer",
			description:
				"Name, colour, `hiddenByDefault` and visibility. Order is changed with `POST /api/layers/reorder`.",
			fails: [400, 403, 404, 429],
			login: true,
		}),
		requireUser,
		validate("json", updateLayerSchema),
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(c.var.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			// Making a layer private or public again is a decision for its creator or a moderator.
			if (
				body.visibility !== undefined &&
				body.visibility !== found.layer.visibility
			) {
				if (!canManageLayer(user, c.var.role, found.layer))
					return c.json({ error: "forbidden" }, 403);
			}
			const updated = db.transaction((tx) => {
				const row = tx
					.update(layers)
					.set(body)
					.where(and(eq(layers.id, found.layer.id), isNull(layers.deletedAt)))
					.returning()
					.get();
				// Whoever makes it private keeps access; the creator has it anyway.
				if (
					row?.visibility === "private" &&
					found.layer.visibility !== "private"
				) {
					tx.insert(layerMembers)
						.values({ layerId: row.id, userId: user.id, role: "editor" })
						.onConflictDoNothing()
						.run();
				}
				return row;
			});
			if (!updated) return c.json({ error: "not found" }, 404);
			announceLayers(c, updated.dimensionId);
			return c.json({
				layer: serializeLayer(
					updated,
					true,
					canManageLayer(user, c.var.role, updated),
				),
			});
		},
	)
	.delete(
		"/:id",
		doc({
			tag: "Layers",
			summary: "Delete a layer",
			description: "The creator or a moderator.",
			fails: [403, 404, 429],
			login: true,
		}),
		requireUser,
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);
			await db
				.update(layers)
				.set({ deletedAt: Date.now() })
				.where(eq(layers.id, found.layer.id));
			announceLayers(c, found.layer.dimensionId);
			return c.json({ ok: true });
		},
	)
	.post(
		"/:id/features",
		doc({
			tag: "Layers",
			summary: "Add a feature to a layer",
			ok: { 201: "Feature created" },
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		requireUser,
		validate("json", featureInputSchema),
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(c.var.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const content = c.req.valid("json");
			const layerId = found.layer.id;
			const view = db.transaction((tx) => {
				if (!layerIsLive(tx, layerId)) return "gone";
				if (liveFeatureCount(tx, layerId) >= MAX_FEATURES_PER_LAYER)
					return "full";
				return insertFeature(
					tx,
					layerId,
					nextFeatureOrder(tx, layerId),
					user.id,
					content,
				);
			});
			if (view === "gone") return c.json({ error: "not found" }, 404);
			if (view === "full") return c.json({ error: "layer is full" }, 409);
			announceLayers(c, found.layer.dimensionId);
			return c.json({ feature: view }, 201);
		},
	)
	.post(
		"/:id/features/reorder",
		doc({
			tag: "Layers",
			summary: "Reorder the features of a layer",
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		requireUser,
		validate("json", reorderSchema),
		async (c) => {
			const { db } = c.var;
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(c.var.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const { ids } = c.req.valid("json");
			const done = db.transaction((tx) => {
				const live = new Set(
					layerFeatures(tx, found.layer.id).map((f) => f.id),
				);
				const all = tx
					.select({ id: features.id, sortOrder: features.sortOrder })
					.from(features)
					.where(eq(features.layerId, found.layer.id))
					.all();
				const current = all.filter((f) => live.has(f.id));
				if (!sameSet(current, ids)) return false;
				// Deleted features keep their rows, which a restore brings back at their old place.
				const deleted = all.filter((f) => !live.has(f.id));
				for (const u of assignOrder(current, ids, deleted))
					tx.update(features)
						.set({ sortOrder: u.sortOrder })
						.where(eq(features.id, u.id))
						.run();
				return true;
			});
			if (!done)
				return c.json({ error: "the list of features is out of date" }, 409);
			announceLayers(c, found.layer.dimensionId);
			return c.json({ ok: true });
		},
	)
	.get(
		"/:id/export",
		doc({
			tag: "Layers",
			summary: "Export a layer as JSON",
			description: "An array of `{type, name, popup, color, geometry}`.",
			fails: [404],
		}),
		async (c) => {
			const { db } = c.var;
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			const list = layerFeatures(db, found.layer.id);
			c.header(
				"Content-Disposition",
				`attachment; filename="layer-${found.layer.id}.json"`,
			);
			return c.json(list.map(contentOf));
		},
	)
	.post(
		"/:id/import",
		doc({
			tag: "Layers",
			summary: "Import features into a layer",
			description:
				"Adds to the layer, or replaces its features with `replace=1`, which only the layer's creator or a moderator may do.",
			ok: { 201: "Imported" },
			fails: [400, 403, 404, 409, 429],
			login: true,
		}),
		requireUser,
		validate("query", z.object({ replace: z.enum(["0", "1"]).optional() })),
		validate("json", featureImportSchema),
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(c.var.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const items = c.req.valid("json");
			const replace = c.req.valid("query").replace === "1";
			if (replace && !canManageLayer(user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);

			const layerId = found.layer.id;
			const out = db.transaction((tx) => {
				if (!layerIsLive(tx, layerId)) return "gone";
				const existing = replace ? layerFeatures(tx, layerId) : [];
				const kept = replace ? 0 : liveFeatureCount(tx, layerId);
				if (kept + items.length > MAX_FEATURES_PER_LAYER) return "full";

				for (const f of existing) {
					insertRevision(tx, f.id, user.id, {
						...contentOf(f),
						deleted: true,
					});
				}
				let order = nextFeatureOrder(tx, layerId);
				for (const item of items)
					insertFeature(tx, layerId, order++, user.id, item);
				return existing.length;
			});
			if (out === "gone") return c.json({ error: "not found" }, 404);
			if (out === "full")
				return c.json(
					{ error: `a layer holds at most ${MAX_FEATURES_PER_LAYER} features` },
					409,
				);
			announceLayers(c, found.layer.dimensionId);
			return c.json({ imported: items.length, replaced: out }, 201);
		},
	)
	.route("/:id/members", layerMemberRoutes)
	.route("/:id/invites", layerInviteRoutes);

import {
	createLayerSchema,
	featureImportSchema,
	featureInputSchema,
	MAX_FEATURES_PER_LAYER,
	reorderLayersSchema,
	reorderSchema,
	updateLayerSchema,
} from "@aomc/shared";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import {
	dimensions,
	features,
	layerMembers,
	layers,
	revisions,
} from "../db/schema";
import {
	contentOf,
	featuresOfLayers,
	insertRevision,
	nextFeatureOrder,
	toView,
} from "../features";
import { doc } from "../openapi";
import { assignOrder, sameSet } from "../order";
import {
	canEdit,
	canEditLayer,
	canManageLayer,
	canViewLayer,
} from "../permissions";
import type { AppEnv } from "../types";
import { layerInviteRoutes } from "./invites";
import { layerMemberRoutes } from "./layerMembers";
import { layerFor } from "./util";

const layerFeatures = async (db: Db, layerId: number) =>
	(await featuresOfLayers(db, [layerId])).get(layerId) ?? [];

type LayerRow = typeof layers.$inferSelect;

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

/** Unix ms time of a revision, for "as of revision" reads. null means "now". */
async function timeOfRev(db: Db, headRev: number, at: number | null) {
	if (at === null || at >= headRev) return null;
	if (at <= 0) return 0;
	const [row] = await db
		.select({ completedAt: revisions.completedAt })
		.from(revisions)
		.where(eq(revisions.rev, at));
	return row?.completedAt ?? null;
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
				"Only layers you may see. `at` reads the layers as of a revision.",
		}),
		validator("query", layersQuerySchema),
		async (c) => {
			const { db, user, map, role } = c.var;
			const query = c.req.valid("query");
			const at = await timeOfRev(
				db,
				map.headRev,
				query.at === undefined ? null : Number(query.at),
			);

			let dimensionId: number | undefined;
			if (query.dim) {
				const [dim] = await db
					.select({ id: dimensions.id })
					.from(dimensions)
					.where(eq(dimensions.slug, query.dim));
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
			const rows = await db
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
				.orderBy(layers.sortOrder, layers.id);

			const memberships = user
				? await db
						.select({ layerId: layerMembers.layerId, role: layerMembers.role })
						.from(layerMembers)
						.where(
							and(
								eq(layerMembers.userId, user.id),
								inArray(
									layerMembers.layerId,
									rows.map((r) => r.id),
								),
							),
						)
				: [];
			const layerRoles = new Map(memberships.map((m) => [m.layerId, m.role]));

			const visible = rows.filter((l) =>
				canViewLayer(role, l, layerRoles.get(l.id) ?? null),
			);
			const byLayer = await featuresOfLayers(
				db,
				visible.map((l) => l.id),
				at,
			);
			return c.json({
				layers: visible.map((l) => ({
					...serializeLayer(
						l,
						canEditLayer(role, l, layerRoles.get(l.id) ?? null),
						canManageLayer(user, role, l),
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
			ok: { 201: "Layer created" },
			fails: [403, 404],
			login: true,
		}),
		requireUser,
		validator("json", createLayerSchema),
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			if (!canEdit(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const [dim] = await db
				.select({ id: dimensions.id })
				.from(dimensions)
				.where(eq(dimensions.slug, body.dimension));
			if (!dim) return c.json({ error: "dimension not found" }, 404);

			const layer = db.transaction((tx) => {
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
						sortOrder: Math.max(-1, ...existing.map((l) => l.sortOrder)) + 1,
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
			fails: [403, 404, 409],
			login: true,
		}),
		requireUser,
		validator("json", reorderLayersSchema),
		async (c) => {
			const { db, role } = c.var;
			const user = userOf(c);
			if (!canEdit(role)) return c.json({ error: "forbidden" }, 403);
			const body = c.req.valid("json");
			const [dim] = await db
				.select({ id: dimensions.id })
				.from(dimensions)
				.where(eq(dimensions.slug, body.dimension));
			if (!dim) return c.json({ error: "dimension not found" }, 404);

			const rows = await db
				.select()
				.from(layers)
				.where(and(eq(layers.dimensionId, dim.id), isNull(layers.deletedAt)));
			const memberships = await db
				.select({ layerId: layerMembers.layerId, role: layerMembers.role })
				.from(layerMembers)
				.where(eq(layerMembers.userId, user.id));
			const layerRoles = new Map(memberships.map((m) => [m.layerId, m.role]));
			// Only the layers this user can see take part; the others keep their places.
			const visible = rows.filter((l) =>
				canViewLayer(role, l, layerRoles.get(l.id) ?? null),
			);
			if (!sameSet(visible, body.ids))
				return c.json({ error: "the list of layers is out of date" }, 409);

			db.transaction((tx) => {
				for (const u of assignOrder(visible, body.ids))
					tx.update(layers)
						.set({ sortOrder: u.sortOrder })
						.where(eq(layers.id, u.id))
						.run();
			});
			return c.json({ ok: true });
		},
	)
	.patch(
		"/:id",
		doc({
			tag: "Layers",
			summary: "Update a layer",
			fails: [403, 404],
			login: true,
		}),
		requireUser,
		validator("json", updateLayerSchema),
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
			const [updated] = await db
				.update(layers)
				.set(body)
				.where(eq(layers.id, found.layer.id))
				.returning();
			if (
				updated &&
				updated.visibility === "private" &&
				found.layer.visibility !== "private"
			) {
				await db
					.insert(layerMembers)
					.values({ layerId: updated.id, userId: user.id, role: "editor" })
					.onConflictDoNothing();
			}
			return c.json({
				layer: serializeLayer(
					updated as LayerRow,
					true,
					canManageLayer(user, c.var.role, updated as LayerRow),
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
			fails: [403, 404],
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
			return c.json({ ok: true });
		},
	)
	.post(
		"/:id/features",
		doc({
			tag: "Layers",
			summary: "Add a feature to a layer",
			ok: { 201: "Feature created" },
			fails: [403, 404, 409],
			login: true,
		}),
		requireUser,
		validator("json", featureInputSchema),
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(c.var.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const existing = await layerFeatures(db, found.layer.id);
			if (existing.length >= MAX_FEATURES_PER_LAYER)
				return c.json({ error: "layer is full" }, 409);

			const content = c.req.valid("json");
			const view = db.transaction((tx) => {
				const feature = tx
					.insert(features)
					.values({
						layerId: found.layer.id,
						sortOrder: nextFeatureOrder(tx, found.layer.id),
					})
					.returning()
					.get();
				return toView(
					feature,
					insertRevision(tx, feature.id, user.id, content),
				);
			});
			return c.json({ feature: view }, 201);
		},
	)
	.post(
		"/:id/features/reorder",
		doc({
			tag: "Layers",
			summary: "Reorder the features of a layer",
			fails: [403, 404, 409],
			login: true,
		}),
		requireUser,
		validator("json", reorderSchema),
		async (c) => {
			const { db } = c.var;
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(c.var.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const { ids } = c.req.valid("json");
			const live = new Set(
				(await layerFeatures(db, found.layer.id)).map((f) => f.id),
			);
			const current = (
				await db
					.select({ id: features.id, sortOrder: features.sortOrder })
					.from(features)
					.where(eq(features.layerId, found.layer.id))
			).filter((f) => live.has(f.id));
			if (!sameSet(current, ids))
				return c.json({ error: "the list of features is out of date" }, 409);

			db.transaction((tx) => {
				for (const u of assignOrder(current, ids))
					tx.update(features)
						.set({ sortOrder: u.sortOrder })
						.where(eq(features.id, u.id))
						.run();
			});
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
			const list = await layerFeatures(db, found.layer.id);
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
				"Adds to the layer, or replaces its features with `replace=1`.",
			ok: { 201: "Imported" },
			fails: [403, 404, 409],
			login: true,
		}),
		requireUser,
		validator("query", z.object({ replace: z.enum(["0", "1"]).optional() })),
		validator("json", featureImportSchema),
		async (c) => {
			const { db } = c.var;
			const user = userOf(c);
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(c.var.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const items = c.req.valid("json");
			const replace = c.req.query("replace") === "1";
			const existing = await layerFeatures(db, found.layer.id);
			if (
				(replace ? 0 : existing.length) + items.length >
				MAX_FEATURES_PER_LAYER
			) {
				return c.json(
					{ error: `a layer holds at most ${MAX_FEATURES_PER_LAYER} features` },
					409,
				);
			}

			db.transaction((tx) => {
				if (replace) {
					for (const f of existing) {
						insertRevision(tx, f.id, user.id, {
							...contentOf(f),
							deleted: true,
						});
					}
				}
				for (const item of items) {
					const feature = tx
						.insert(features)
						.values({
							layerId: found.layer.id,
							sortOrder: nextFeatureOrder(tx, found.layer.id),
						})
						.returning()
						.get();
					insertRevision(tx, feature.id, user.id, item);
				}
			});
			return c.json(
				{ imported: items.length, replaced: replace ? existing.length : 0 },
				201,
			);
		},
	)
	.route("/:id/members", layerMemberRoutes)
	.route("/:id/invites", layerInviteRoutes);

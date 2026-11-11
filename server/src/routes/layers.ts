import {
	createLayerSchema,
	featureImportSchema,
	featureInputSchema,
	MAX_FEATURES_PER_LAYER,
	updateLayerSchema,
} from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { Hono } from "hono";
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
	toView,
} from "../features";
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
	.get("/", zValidator("query", layersQuerySchema), async (c) => {
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
	})
	.post("/", requireUser, zValidator("json", createLayerSchema), async (c) => {
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
	})
	.patch(
		"/:id",
		requireUser,
		zValidator("json", updateLayerSchema),
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
	.delete("/:id", requireUser, async (c) => {
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
	})
	.post(
		"/:id/features",
		requireUser,
		zValidator("json", featureInputSchema),
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
					.values({ layerId: found.layer.id })
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
	.get("/:id/export", async (c) => {
		const { db } = c.var;
		const found = await layerFor(c, c.req.param("id"));
		if (!found) return c.json({ error: "not found" }, 404);
		const list = await layerFeatures(db, found.layer.id);
		c.header(
			"Content-Disposition",
			`attachment; filename="layer-${found.layer.id}.json"`,
		);
		return c.json(list.map(contentOf));
	})
	.post(
		"/:id/import",
		requireUser,
		zValidator("query", z.object({ replace: z.enum(["0", "1"]).optional() })),
		zValidator("json", featureImportSchema),
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
						.values({ layerId: found.layer.id })
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

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
import { requireUser } from "../auth/session";
import type { Db } from "../db/client";
import {
	dimensions,
	features,
	layerMembers,
	layers,
	revisions,
} from "../db/schema";
import {
	featuresOfLayers,
	insertRevision,
	type RevisionContent,
} from "../features";
import {
	canCreateLayers,
	canDeleteLayer,
	canEditLayer,
	canViewLayer,
	loadLayerAccess,
	loadMapAccess,
} from "../permissions";
import type { AppEnv } from "../types";

const parseId = (value: string | undefined) =>
	/^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;

type LayerRow = typeof layers.$inferSelect;

function serializeLayer(layer: LayerRow, canEdit: boolean) {
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
	};
}

/** Unix ms time of a revision, for "as of revision" reads. null means "now". */
async function timeOfRev(
	db: Db,
	mapId: number,
	headRev: number,
	at: number | null,
) {
	if (at === null || at >= headRev) return null;
	if (at <= 0) return 0;
	const [row] = await db
		.select({ completedAt: revisions.completedAt })
		.from(revisions)
		.where(and(eq(revisions.mapId, mapId), eq(revisions.rev, at)));
	return row?.completedAt ?? null;
}

const layersQuerySchema = z.object({
	dim: z.string().optional(),
	at: z.string().regex(/^\d+$/).optional(),
});

/** GET/POST /api/maps/:slug/layers */
export const mapLayerRoutes = new Hono<AppEnv>()
	.get("/", zValidator("query", layersQuerySchema), async (c) => {
		const { db, user } = c.var;
		const access = await loadMapAccess(db, user, c.req.param("slug") ?? "");
		if (!access) return c.json({ error: "not found" }, 404);

		const atParam = c.req.query("at");
		if (atParam !== undefined && !/^\d+$/.test(atParam))
			return c.json({ error: "bad at" }, 400);
		const at = await timeOfRev(
			db,
			access.map.id,
			access.map.headRev,
			atParam === undefined ? null : Number(atParam),
		);

		const dimSlug = c.req.query("dim");
		let dimensionId: number | undefined;
		if (dimSlug) {
			const [dim] = await db
				.select({ id: dimensions.id })
				.from(dimensions)
				.where(
					and(
						eq(dimensions.mapId, access.map.id),
						eq(dimensions.slug, dimSlug),
					),
				);
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
					eq(layers.mapId, access.map.id),
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
			canViewLayer(access.role, l, layerRoles.get(l.id) ?? null),
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
					canEditLayer(access.role, l, layerRoles.get(l.id) ?? null),
				),
				features: byLayer.get(l.id) ?? [],
			})),
		});
	})
	.post("/", requireUser, zValidator("json", createLayerSchema), async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const access = await loadMapAccess(db, user, c.req.param("slug") ?? "");
		if (!access) return c.json({ error: "not found" }, 404);
		if (!canCreateLayers(access.role))
			return c.json({ error: "forbidden" }, 403);

		const body = c.req.valid("json");
		const [dim] = await db
			.select({ id: dimensions.id })
			.from(dimensions)
			.where(
				and(
					eq(dimensions.mapId, access.map.id),
					eq(dimensions.slug, body.dimension),
				),
			);
		if (!dim) return c.json({ error: "dimension not found" }, 404);

		const layer = db.transaction((tx) => {
			const existing = tx
				.select({ sortOrder: layers.sortOrder })
				.from(layers)
				.where(and(eq(layers.mapId, access.map.id), isNull(layers.deletedAt)))
				.all();
			const row = tx
				.insert(layers)
				.values({
					mapId: access.map.id,
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
			{ layer: { ...serializeLayer(layer, true), features: [] } },
			201,
		);
	});

/** /api/layers/:id */
export const layerRoutes = new Hono<AppEnv>()
	.patch(
		"/:id",
		requireUser,
		zValidator("json", updateLayerSchema),
		async (c) => {
			const { db } = c.var;
			const user = c.var.user as NonNullable<typeof c.var.user>;
			const found = await loadLayerAccess(db, user, parseId(c.req.param("id")));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(found.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			// Making a layer private or public again is a decision for its creator or a moderator.
			if (
				body.visibility !== undefined &&
				body.visibility !== found.layer.visibility
			) {
				if (!canDeleteLayer(user, found.role, found.layer))
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
			return c.json({ layer: serializeLayer(updated as LayerRow, true) });
		},
	)
	.delete("/:id", requireUser, async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadLayerAccess(db, user, parseId(c.req.param("id")));
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canDeleteLayer(user, found.role, found.layer))
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
			const user = c.var.user as NonNullable<typeof c.var.user>;
			const found = await loadLayerAccess(db, user, parseId(c.req.param("id")));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(found.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const count =
				(await featuresOfLayers(db, [found.layer.id])).get(found.layer.id)
					?.length ?? 0;
			if (count >= MAX_FEATURES_PER_LAYER)
				return c.json({ error: "layer is full" }, 409);

			const content = c.req.valid("json");
			const created = db.transaction((tx) => {
				const feature = tx
					.insert(features)
					.values({ layerId: found.layer.id })
					.returning()
					.get();
				const revision = insertRevision(tx, feature.id, user.id, content);
				return { feature, revision };
			});
			const [view] =
				(await featuresOfLayers(db, [found.layer.id]))
					.get(found.layer.id)
					?.filter((f) => f.id === created.feature.id) ?? [];
			return c.json({ feature: view }, 201);
		},
	)
	.get("/:id/export", async (c) => {
		const { db } = c.var;
		const found = await loadLayerAccess(
			db,
			c.var.user,
			parseId(c.req.param("id")),
		);
		if (!found) return c.json({ error: "not found" }, 404);
		const list =
			(await featuresOfLayers(db, [found.layer.id])).get(found.layer.id) ?? [];
		c.header(
			"Content-Disposition",
			`attachment; filename="layer-${found.layer.id}.json"`,
		);
		return c.json(
			list.map((f) => ({
				type: f.type,
				name: f.name,
				popup: f.popup,
				color: f.color,
				geometry: f.geometry,
			})),
		);
	})
	.post(
		"/:id/import",
		requireUser,
		zValidator("query", z.object({ replace: z.enum(["0", "1"]).optional() })),
		zValidator("json", featureImportSchema),
		async (c) => {
			const { db } = c.var;
			const user = c.var.user as NonNullable<typeof c.var.user>;
			const found = await loadLayerAccess(db, user, parseId(c.req.param("id")));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canEditLayer(found.role, found.layer, found.layerRole))
				return c.json({ error: "forbidden" }, 403);

			const items = c.req.valid("json");
			const replace = c.req.query("replace") === "1";
			const existing =
				(await featuresOfLayers(db, [found.layer.id])).get(found.layer.id) ??
				[];
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
							type: f.type,
							name: f.name,
							popup: f.popup,
							color: f.color,
							geometry: f.geometry,
							deleted: true,
						} as RevisionContent);
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
	);

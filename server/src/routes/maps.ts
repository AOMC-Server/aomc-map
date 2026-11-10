import { createMapSchema, updateMapSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { dimensions, mapMembers, maps } from "../db/schema";
import {
	canChangeTileSize,
	canDeleteMap,
	canManageSettings,
	loadMapAccess,
} from "../permissions";
import type { AppEnv } from "../types";
import { dimensionRoutes } from "./dimensions";
import { memberRoutes } from "./members";

const publicFields = {
	id: maps.id,
	slug: maps.slug,
	name: maps.name,
	visibility: maps.visibility,
	isDefault: maps.isDefault,
	tileSize: maps.tileSize,
	headRev: maps.headRev,
	createdAt: maps.createdAt,
};

export const mapRoutes = new Hono<AppEnv>()
	.get("/", async (c) => {
		const user = c.var.user;
		const visible = user
			? or(
					eq(maps.visibility, "public"),
					eq(
						maps.id,
						c.var.db
							.select({ id: mapMembers.mapId })
							.from(mapMembers)
							.where(
								and(
									eq(mapMembers.userId, user.id),
									eq(mapMembers.mapId, maps.id),
								),
							),
					),
				)
			: eq(maps.visibility, "public");
		const rows = await c.var.db.select(publicFields).from(maps).where(visible);
		return c.json({ maps: rows });
	})
	.post("/", requireUser, zValidator("json", createMapSchema), async (c) => {
		const body = c.req.valid("json");
		const user = c.var.user!;
		const [taken] = await c.var.db
			.select({ id: maps.id })
			.from(maps)
			.where(eq(maps.slug, body.slug));
		if (taken) return c.json({ error: "slug already in use" }, 409);

		const map = c.var.db.transaction((tx) => {
			const row = tx
				.insert(maps)
				.values({
					slug: body.slug,
					name: body.name,
					visibility: body.visibility,
					ownerId: user.id,
					tileSize: body.tileSize ?? c.var.env.DEFAULT_TILE_SIZE,
				})
				.returning(publicFields)
				.get();
			tx.insert(mapMembers)
				.values({ mapId: row.id, userId: user.id, role: "owner" })
				.run();
			return row;
		});
		return c.json({ map }, 201);
	})
	.get("/:slug", async (c) => {
		const access = await loadMapAccess(
			c.var.db,
			c.var.user,
			c.req.param("slug"),
		);
		if (!access) return c.json({ error: "not found" }, 404);
		const dims = await c.var.db
			.select()
			.from(dimensions)
			.where(eq(dimensions.mapId, access.map.id))
			.orderBy(dimensions.sortOrder, dimensions.id);
		const { map } = access;
		return c.json({
			map: {
				id: map.id,
				slug: map.slug,
				name: map.name,
				visibility: map.visibility,
				isDefault: map.isDefault,
				tileSize: map.tileSize,
				headRev: map.headRev,
				createdAt: map.createdAt,
			},
			role: access.role,
			dimensions: dims.map((d) => ({
				id: d.id,
				slug: d.slug,
				name: d.name,
				sortOrder: d.sortOrder,
				archived: d.archived,
			})),
		});
	})
	.patch(
		"/:slug",
		requireUser,
		zValidator("json", updateMapSchema),
		async (c) => {
			const access = await loadMapAccess(
				c.var.db,
				c.var.user,
				c.req.param("slug"),
			);
			if (!access) return c.json({ error: "not found" }, 404);
			if (!canManageSettings(access.role))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			if (body.visibility === "private" && access.map.isDefault) {
				return c.json({ error: "the default map must stay public" }, 400);
			}
			if (
				body.tileSize !== undefined &&
				body.tileSize !== access.map.tileSize
			) {
				if (!canChangeTileSize(access.role, access.map)) {
					return c.json(
						{ error: "tile size cannot change once the map has uploads" },
						409,
					);
				}
			}
			const [map] = await c.var.db
				.update(maps)
				.set({
					name: body.name,
					visibility: body.visibility,
					tileSize: body.tileSize,
				})
				.where(eq(maps.id, access.map.id))
				.returning(publicFields);
			return c.json({ map });
		},
	)
	.delete("/:slug", requireUser, async (c) => {
		const access = await loadMapAccess(
			c.var.db,
			c.var.user,
			c.req.param("slug"),
		);
		if (!access) return c.json({ error: "not found" }, 404);
		if (!canDeleteMap(access.role)) return c.json({ error: "forbidden" }, 403);
		if (access.map.isDefault)
			return c.json({ error: "the default map cannot be deleted" }, 400);
		await c.var.db.delete(maps).where(eq(maps.id, access.map.id));
		return c.json({ ok: true });
	})
	.route("/:slug/dimensions", dimensionRoutes)
	.route("/:slug/members", memberRoutes);

import { updateMapSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { dimensions, maps } from "../db/schema";
import {
	canChangeTileSize,
	canManageSettings,
	loadMapAccess,
} from "../permissions";
import type { AppEnv } from "../types";
import { dimensionRoutes } from "./dimensions";
import { mapInviteRoutes } from "./invites";
import { mapLayerRoutes } from "./layers";
import { memberRoutes } from "./members";
import { mapRevisionRoutes } from "./revisions";

const publicFields = {
	id: maps.id,
	slug: maps.slug,
	name: maps.name,
	tileSize: maps.tileSize,
	headRev: maps.headRev,
	createdAt: maps.createdAt,
};

export const mapRoutes = new Hono<AppEnv>()
	.get("/", async (c) => {
		const rows = await c.var.db.select(publicFields).from(maps);
		return c.json({ maps: rows });
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
				tileSize: map.tileSize,
				headRev: map.headRev,
				createdAt: map.createdAt,
			},
			role: access.role,
			maxZoom: c.var.env.MAX_ZOOM,
			limits: {
				maxUploadBytes: c.var.env.MAX_UPLOAD_BYTES,
				maxFilesPerUpload: c.var.env.MAX_FILES_PER_UPLOAD,
				maxImageDim: c.var.env.MAX_IMAGE_DIM,
			},
			dimensions: dims.map((d) => ({
				id: d.id,
				slug: d.slug,
				name: d.name,
				sortOrder: d.sortOrder,
				archived: d.archived,
				scale: d.scale,
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
				.set({ name: body.name, tileSize: body.tileSize })
				.where(eq(maps.id, access.map.id))
				.returning(publicFields);
			return c.json({ map });
		},
	)
	.route("/:slug/dimensions", dimensionRoutes)
	.route("/:slug/members", memberRoutes)
	.route("/:slug/revisions", mapRevisionRoutes)
	.route("/:slug/layers", mapLayerRoutes)
	.route("/:slug/invites", mapInviteRoutes);

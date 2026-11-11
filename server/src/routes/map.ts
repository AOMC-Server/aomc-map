import { updateMapSchema } from "@aomc/shared";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import { requireUser } from "../auth/session";
import { mapInfo } from "../db/schema";
import { doc } from "../openapi";
import { canManage } from "../permissions";
import type { AppEnv } from "../types";

const mapFields = (m: typeof mapInfo.$inferSelect) => ({
	name: m.name,
	tileSize: m.tileSize,
	headRev: m.headRev,
	epoch: m.epoch,
	createdAt: m.createdAt,
});

export const mapRoutes = new Hono<AppEnv>()
	.get(
		"/",
		doc({ tag: "Map", summary: "Get the map, its dimensions and your role" }),
		async (c) => {
			const { db, env, map, role } = c.var;
			const dims = await db.query.dimensions.findMany({
				orderBy: (d, { asc }) => [asc(d.sortOrder), asc(d.id)],
			});
			return c.json({
				map: mapFields(map),
				role,
				maxZoom: env.MAX_ZOOM,
				limits: {
					maxUploadBytes: env.MAX_UPLOAD_BYTES,
					maxFilesPerUpload: env.MAX_FILES_PER_UPLOAD,
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
		},
	)
	.patch(
		"/",
		doc({
			tag: "Map",
			summary: "Update the map settings",
			fails: [403],
			login: true,
		}),
		requireUser,
		validator("json", updateMapSchema),
		async (c) => {
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const [updated] = await c.var.db
				.update(mapInfo)
				.set(c.req.valid("json"))
				.returning();
			return c.json({ map: mapFields(updated as typeof mapInfo.$inferSelect) });
		},
	);

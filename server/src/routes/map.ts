import {
	MAX_FEATURES_PER_LAYER,
	MAX_JSON_BYTES,
	MAX_LAYERS_PER_USER,
	updateMapSchema,
} from "@aomc/shared";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { mapInfo } from "../db/schema";
import { doc } from "../openapi";
import { canManage } from "../permissions";
import type { AppEnv } from "../types";
import { validate } from "../validate";

const mapFields = (m: typeof mapInfo.$inferSelect) => ({
	name: m.name,
	tileSize: m.tileSize,
	headRev: m.headRev,
	epoch: m.epoch,
	maintenance: m.maintenance,
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
				privacy: {
					controller: env.PRIVACY_CONTROLLER,
					contact: env.PRIVACY_CONTACT,
				},
				limits: {
					maxUploadBytes: env.MAX_UPLOAD_BYTES,
					maxFilesPerUpload: env.MAX_FILES_PER_UPLOAD,
					selfDeleteWindowHours: env.SELF_DELETE_WINDOW_HOURS,
					maxJsonBytes: MAX_JSON_BYTES,
					maxFeaturesPerLayer: MAX_FEATURES_PER_LAYER,
					maxLayersPerUser: MAX_LAYERS_PER_USER,
				},
				dimensions: dims.map((d) => ({
					id: d.id,
					slug: d.slug,
					name: d.name,
					sortOrder: d.sortOrder,
					archived: d.archived,
					scale: d.scale,
					theme: d.theme,
					preload: d.preload,
					xaeroDimension: d.xaeroDimension,
				})),
			});
		},
	)
	.patch(
		"/",
		doc({
			tag: "Map",
			summary: "Update the map settings",
			description:
				'`maintenance` makes the map read only for everyone but owners: their writes answer 503 with `reason: "maintenance"`, except to their own account, tokens and short links.',
			fails: [400, 403],
			login: true,
		}),
		requireUser,
		validate("json", updateMapSchema),
		async (c) => {
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const [updated] = await c.var.db
				.update(mapInfo)
				.set(c.req.valid("json"))
				.returning();
			return c.json({ map: mapFields(updated as typeof mapInfo.$inferSelect) });
		},
	);

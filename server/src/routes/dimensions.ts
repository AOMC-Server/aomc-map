import {
	createDimensionSchema,
	guessDimensionTheme,
	updateDimensionSchema,
} from "@aomc/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import { requireUser } from "../auth/session";
import { dimensions } from "../db/schema";
import { doc } from "../openapi";
import { canModerate } from "../permissions";
import type { AppEnv } from "../types";
import { tileRoutes } from "./tiles";
import { uploadRoutes } from "./uploads";

export const dimensionRoutes = new Hono<AppEnv>()
	.post(
		"/",
		doc({
			tag: "Map",
			summary: "Create a dimension",
			description: "Moderators.",
			ok: { 201: "Dimension created" },
			fails: [400, 403, 409],
			login: true,
		}),
		requireUser,
		validator("json", createDimensionSchema),
		async (c) => {
			const { db } = c.var;
			if (!canModerate(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const existing = await db
				.select({ sortOrder: dimensions.sortOrder })
				.from(dimensions);
			if (existing.length >= 50)
				return c.json({ error: "too many dimensions" }, 400);
			try {
				const [dimension] = await db
					.insert(dimensions)
					.values({
						slug: body.slug,
						name: body.name,
						scale: body.scale ?? null,
						theme: body.theme ?? guessDimensionTheme(body.slug),
						preload: body.preload,
						sortOrder: Math.max(-1, ...existing.map((d) => d.sortOrder)) + 1,
					})
					.returning();
				return c.json({ dimension }, 201);
			} catch {
				return c.json({ error: "dimension slug already in use" }, 409);
			}
		},
	)
	.patch(
		"/:dim",
		doc({
			tag: "Map",
			summary: "Update a dimension",
			description: "Moderators. `dim` is the slug.",
			fails: [403, 404],
			login: true,
		}),
		requireUser,
		validator("json", updateDimensionSchema),
		async (c) => {
			if (!canModerate(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const [dimension] = await c.var.db
				.update(dimensions)
				.set(body)
				.where(eq(dimensions.slug, c.req.param("dim")))
				.returning();
			return dimension
				? c.json({ dimension })
				: c.json({ error: "not found" }, 404);
		},
	)
	.route("/:dim/tiles", tileRoutes)
	.route("/:dim/uploads", uploadRoutes);

import { createDimensionSchema, updateDimensionSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { dimensions } from "../db/schema";
import { canModerate } from "../permissions";
import type { AppEnv } from "../types";
import { tileRoutes } from "./tiles";
import { uploadRoutes } from "./uploads";

export const dimensionRoutes = new Hono<AppEnv>()
	.post(
		"/",
		requireUser,
		zValidator("json", createDimensionSchema),
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
		requireUser,
		zValidator("json", updateDimensionSchema),
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

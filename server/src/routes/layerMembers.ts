import { layerMemberRoleSchema, layerMemberSchema } from "@aomc/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import { requireUser, userOf } from "../auth/session";
import { layerMembers, users } from "../db/schema";
import { doc } from "../openapi";
import { canManageLayer } from "../permissions";
import type { AppEnv } from "../types";
import { layerFor } from "./util";

/** /api/layers/:id/members: who may see and edit a private layer. */
export const layerMemberRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get(
		"/",
		doc({
			tag: "Sharing",
			summary: "List a layer's members",
			fails: [403, 404],
			login: true,
		}),
		async (c) => {
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);
			const members = await c.var.db
				.select({
					userId: layerMembers.userId,
					role: layerMembers.role,
					username: users.username,
					avatarUrl: users.avatarUrl,
				})
				.from(layerMembers)
				.innerJoin(users, eq(users.id, layerMembers.userId))
				.where(eq(layerMembers.layerId, found.layer.id));
			return c.json({ members });
		},
	)
	.post(
		"/",
		doc({
			tag: "Sharing",
			summary: "Add a layer member or change their role",
			description: "The user must have logged in once.",
			ok: { 201: "Role set" },
			fails: [403, 404],
			login: true,
		}),
		validator("json", layerMemberSchema),
		async (c) => {
			const { db } = c.var;
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const [target] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, body.userId));
			if (!target)
				return c.json(
					{ error: "user not found (they must log in once first)" },
					404,
				);

			await db
				.insert(layerMembers)
				.values({ layerId: found.layer.id, userId: target.id, role: body.role })
				.onConflictDoUpdate({
					target: [layerMembers.layerId, layerMembers.userId],
					set: { role: body.role },
				});
			return c.json({ ok: true }, 201);
		},
	)
	.patch(
		"/:userId",
		doc({
			tag: "Sharing",
			summary: "Change a layer member's role",
			fails: [403, 404],
			login: true,
		}),
		validator("json", layerMemberRoleSchema),
		async (c) => {
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);

			const rows = await c.var.db
				.update(layerMembers)
				.set({ role: c.req.valid("json").role })
				.where(
					and(
						eq(layerMembers.layerId, found.layer.id),
						eq(layerMembers.userId, c.req.param("userId") ?? ""),
					),
				)
				.returning({ userId: layerMembers.userId });
			return rows.length > 0
				? c.json({ ok: true })
				: c.json({ error: "not found" }, 404);
		},
	)
	.delete(
		"/:userId",
		doc({
			tag: "Sharing",
			summary: "Remove a layer member",
			description: "Members may always remove themselves.",
			fails: [403, 404],
			login: true,
		}),
		async (c) => {
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			const userId = c.req.param("userId") ?? "";
			// Members may always leave a layer themselves.
			if (
				userId !== userOf(c).id &&
				!canManageLayer(c.var.user, c.var.role, found.layer)
			) {
				return c.json({ error: "forbidden" }, 403);
			}
			const rows = await c.var.db
				.delete(layerMembers)
				.where(
					and(
						eq(layerMembers.layerId, found.layer.id),
						eq(layerMembers.userId, userId),
					),
				)
				.returning({ userId: layerMembers.userId });
			return rows.length > 0
				? c.json({ ok: true })
				: c.json({ error: "not found" }, 404);
		},
	);

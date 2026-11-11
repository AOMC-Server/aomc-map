import { layerMemberRoleSchema, layerMemberSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { layerMembers, users } from "../db/schema";
import { canManageLayerMembers, loadLayerAccess } from "../permissions";
import type { AppEnv } from "../types";

const parseId = (value: string | undefined) =>
	/^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;

/** /api/layers/:id/members: who may see and edit a private layer. */
export const layerMemberRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get("/", async (c) => {
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadLayerAccess(
			c.var.db,
			user,
			parseId(c.req.param("id")),
		);
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canManageLayerMembers(user, found.role, found.layer))
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
	})
	.post("/", zValidator("json", layerMemberSchema), async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadLayerAccess(db, user, parseId(c.req.param("id")));
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canManageLayerMembers(user, found.role, found.layer))
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
	})
	.patch("/:userId", zValidator("json", layerMemberRoleSchema), async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadLayerAccess(db, user, parseId(c.req.param("id")));
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canManageLayerMembers(user, found.role, found.layer))
			return c.json({ error: "forbidden" }, 403);

		const rows = await db
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
	})
	.delete("/:userId", async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadLayerAccess(db, user, parseId(c.req.param("id")));
		if (!found) return c.json({ error: "not found" }, 404);
		const userId = c.req.param("userId") ?? "";
		// Members may always leave a layer themselves.
		if (
			userId !== user.id &&
			!canManageLayerMembers(user, found.role, found.layer)
		) {
			return c.json({ error: "forbidden" }, 403);
		}
		const rows = await db
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
	});

import { setMemberSchema, updateMemberSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { mapMembers, users } from "../db/schema";
import { canManageMembers, leavesNoOwner, loadMapAccess } from "../permissions";
import type { AppEnv } from "../types";

export const memberRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get("/", async (c) => {
		const access = await loadMapAccess(
			c.var.db,
			c.var.user,
			c.req.param("slug") ?? "",
		);
		if (!access) return c.json({ error: "not found" }, 404);
		if (!canManageMembers(access.role))
			return c.json({ error: "forbidden" }, 403);
		const members = await c.var.db
			.select({
				userId: mapMembers.userId,
				role: mapMembers.role,
				username: users.username,
				avatarUrl: users.avatarUrl,
			})
			.from(mapMembers)
			.innerJoin(users, eq(users.id, mapMembers.userId))
			.where(eq(mapMembers.mapId, access.map.id));
		return c.json({ members });
	})
	.post("/", zValidator("json", setMemberSchema), async (c) => {
		const access = await loadMapAccess(
			c.var.db,
			c.var.user,
			c.req.param("slug") ?? "",
		);
		if (!access) return c.json({ error: "not found" }, 404);
		if (!canManageMembers(access.role))
			return c.json({ error: "forbidden" }, 403);

		const body = c.req.valid("json");
		const [target] = await c.var.db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, body.userId));
		if (!target)
			return c.json(
				{ error: "user not found (they must log in once first)" },
				404,
			);

		const err = await guardLastOwner(
			c.var.db,
			access.map.id,
			body.userId,
			body.role,
		);
		if (err) return c.json({ error: err }, 409);

		await c.var.db
			.insert(mapMembers)
			.values({
				mapId: access.map.id,
				userId: body.userId,
				role: body.role,
				addedBy: c.var.user!.id,
			})
			.onConflictDoUpdate({
				target: [mapMembers.mapId, mapMembers.userId],
				set: { role: body.role },
			});
		return c.json({ ok: true }, 201);
	})
	.patch("/:userId", zValidator("json", updateMemberSchema), async (c) => {
		const access = await loadMapAccess(
			c.var.db,
			c.var.user,
			c.req.param("slug") ?? "",
		);
		if (!access) return c.json({ error: "not found" }, 404);
		if (!canManageMembers(access.role))
			return c.json({ error: "forbidden" }, 403);

		const userId = c.req.param("userId");
		const { role } = c.req.valid("json");
		const current = await memberRole(c.var.db, access.map.id, userId);
		if (!current) return c.json({ error: "not found" }, 404);
		const err = await guardLastOwner(c.var.db, access.map.id, userId, role);
		if (err) return c.json({ error: err }, 409);

		await c.var.db
			.update(mapMembers)
			.set({ role })
			.where(
				and(eq(mapMembers.mapId, access.map.id), eq(mapMembers.userId, userId)),
			);
		return c.json({ ok: true });
	})
	.delete("/:userId", async (c) => {
		const access = await loadMapAccess(
			c.var.db,
			c.var.user,
			c.req.param("slug") ?? "",
		);
		if (!access) return c.json({ error: "not found" }, 404);
		const userId = c.req.param("userId");
		// Members may always remove themselves unless they are the last owner.
		const self = userId === c.var.user!.id;
		if (!self && !canManageMembers(access.role))
			return c.json({ error: "forbidden" }, 403);

		const current = await memberRole(c.var.db, access.map.id, userId);
		if (!current) return c.json({ error: "not found" }, 404);
		const err = await guardLastOwner(c.var.db, access.map.id, userId, null);
		if (err) return c.json({ error: err }, 409);

		await c.var.db
			.delete(mapMembers)
			.where(
				and(eq(mapMembers.mapId, access.map.id), eq(mapMembers.userId, userId)),
			);
		return c.json({ ok: true });
	});

async function memberRole(
	db: AppEnv["Variables"]["db"],
	mapId: number,
	userId: string,
) {
	const [row] = await db
		.select({ role: mapMembers.role })
		.from(mapMembers)
		.where(and(eq(mapMembers.mapId, mapId), eq(mapMembers.userId, userId)));
	return row?.role ?? null;
}

async function guardLastOwner(
	db: AppEnv["Variables"]["db"],
	mapId: number,
	userId: string,
	next: "viewer" | "editor" | "moderator" | "owner" | null,
): Promise<string | null> {
	const current = await memberRole(db, mapId, userId);
	if (!current) return null;
	const [row] = await db
		.select({ owners: count() })
		.from(mapMembers)
		.where(and(eq(mapMembers.mapId, mapId), eq(mapMembers.role, "owner")));
	return leavesNoOwner(row?.owners ?? 0, current, next)
		? "a map must keep at least one owner"
		: null;
}

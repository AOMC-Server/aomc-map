import { setMemberSchema, updateMemberSchema } from "@aomc/shared";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono-openapi";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { members, users } from "../db/schema";
import { doc } from "../openapi";
import { canManage, leavesNoOwner } from "../permissions";
import type { AppEnv } from "../types";

async function guardLastOwner(
	db: Db,
	userId: string,
	next: "moderator" | "owner" | null,
): Promise<string | null> {
	const [current] = await db
		.select({ role: members.role })
		.from(members)
		.where(eq(members.userId, userId));
	if (!current) return null;
	const [row] = await db
		.select({ owners: count() })
		.from(members)
		.where(eq(members.role, "owner"));
	return leavesNoOwner(row?.owners ?? 0, current.role, next)
		? "the map must keep at least one owner"
		: null;
}

export const memberRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get(
		"/",
		doc({
			tag: "Map",
			summary: "List members",
			description: "Owners.",
			fails: [403],
			login: true,
		}),
		async (c) => {
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			const rows = await c.var.db
				.select({
					userId: members.userId,
					role: members.role,
					username: users.username,
					avatarUrl: users.avatarUrl,
				})
				.from(members)
				.innerJoin(users, eq(users.id, members.userId));
			return c.json({ members: rows });
		},
	)
	.post(
		"/",
		doc({
			tag: "Map",
			summary: "Add a member or change their role",
			description: "Owners. The user must have logged in once.",
			ok: { 201: "Role set" },
			fails: [403, 404, 409],
			login: true,
		}),
		validator("json", setMemberSchema),
		async (c) => {
			const { db } = c.var;
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);

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
			const err = await guardLastOwner(db, body.userId, body.role);
			if (err) return c.json({ error: err }, 409);

			await db
				.insert(members)
				.values({ userId: body.userId, role: body.role })
				.onConflictDoUpdate({
					target: members.userId,
					set: { role: body.role },
				});
			return c.json({ ok: true }, 201);
		},
	)
	.patch(
		"/:userId",
		doc({
			tag: "Map",
			summary: "Change a member's role",
			description: "Owners. The last owner cannot be demoted.",
			fails: [403, 404, 409],
			login: true,
		}),
		validator("json", updateMemberSchema),
		async (c) => {
			const { db } = c.var;
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const userId = c.req.param("userId");
			const { role } = c.req.valid("json");
			const [current] = await db
				.select({ role: members.role })
				.from(members)
				.where(eq(members.userId, userId));
			if (!current) return c.json({ error: "not found" }, 404);
			const err = await guardLastOwner(db, userId, role);
			if (err) return c.json({ error: err }, 409);

			await db.update(members).set({ role }).where(eq(members.userId, userId));
			return c.json({ ok: true });
		},
	)
	.delete(
		"/:userId",
		doc({
			tag: "Map",
			summary: "Remove a member",
			description:
				"Owners, or the member themselves. The last owner cannot be removed.",
			fails: [403, 404, 409],
			login: true,
		}),
		async (c) => {
			const { db } = c.var;
			const userId = c.req.param("userId");
			// Members may always step down themselves, unless they are the last owner.
			if (userId !== userOf(c).id && !canManage(c.var.role))
				return c.json({ error: "forbidden" }, 403);

			const deleted = await db
				.select({ role: members.role })
				.from(members)
				.where(eq(members.userId, userId))
				.get();
			if (!deleted) return c.json({ error: "not found" }, 404);
			const err = await guardLastOwner(db, userId, null);
			if (err) return c.json({ error: err }, 409);

			await db.delete(members).where(eq(members.userId, userId));
			return c.json({ ok: true });
		},
	);

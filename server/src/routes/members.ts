import {
	type MemberRole,
	setMemberSchema,
	updateMemberSchema,
} from "@aomc/shared";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { members, users } from "../db/schema";
import { doc } from "../openapi";
import { canManage, leavesNoOwner } from "../permissions";
import type { AppEnv } from "../types";
import { validate } from "../validate";
import { findUser, mayRemove, UNKNOWN_USER_ERROR } from "./util";

type Reader = Pick<Db, "select">;

/** Run the check and the write that depends on it as one unit. */
const atomically = <T>(
	db: Db,
	fn: (tx: Reader & Pick<Db, "insert" | "update" | "delete">) => T,
) => db.transaction(fn, { behavior: "immediate" });

function guardLastOwner(
	db: Reader,
	userId: string,
	next: MemberRole | null,
): string | null {
	const current = db
		.select({ role: members.role })
		.from(members)
		.where(eq(members.userId, userId))
		.get();
	if (!current) return null;
	const row = db
		.select({ owners: count() })
		.from(members)
		.where(eq(members.role, "owner"))
		.get();
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
			fails: [400, 403, 404, 409],
			login: true,
		}),
		validate("json", setMemberSchema),
		async (c) => {
			const { db } = c.var;
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			if (!findUser(db, body.userId))
				return c.json({ error: UNKNOWN_USER_ERROR }, 404);
			const err = atomically(db, (tx) => {
				const blocked = guardLastOwner(tx, body.userId, body.role);
				if (blocked) return blocked;
				tx.insert(members)
					.values({ userId: body.userId, role: body.role })
					.onConflictDoUpdate({
						target: members.userId,
						set: { role: body.role },
					})
					.run();
				return null;
			});
			if (err) return c.json({ error: err }, 409);
			return c.json({ ok: true }, 201);
		},
	)
	.patch(
		"/:userId",
		doc({
			tag: "Map",
			summary: "Change a member's role",
			description: "Owners. The last owner cannot be demoted.",
			fails: [400, 403, 404, 409],
			login: true,
		}),
		validate("json", updateMemberSchema),
		async (c) => {
			const { db } = c.var;
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const userId = c.req.param("userId");
			const { role } = c.req.valid("json");
			const result = atomically(db, (tx) => {
				const current = tx
					.select({ role: members.role })
					.from(members)
					.where(eq(members.userId, userId))
					.get();
				if (!current) return "missing";
				const blocked = guardLastOwner(tx, userId, role);
				if (blocked) return blocked;
				tx.update(members)
					.set({ role })
					.where(eq(members.userId, userId))
					.run();
				return null;
			});
			if (result === "missing") return c.json({ error: "not found" }, 404);
			if (result) return c.json({ error: result }, 409);
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
			if (!mayRemove(userOf(c), userId, canManage(c.var.role)))
				return c.json({ error: "forbidden" }, 403);

			// Members may always step down themselves, unless they are the last owner.
			const result = atomically(db, (tx) => {
				const present = tx
					.select({ role: members.role })
					.from(members)
					.where(eq(members.userId, userId))
					.get();
				if (!present) return "missing";
				const blocked = guardLastOwner(tx, userId, null);
				if (blocked) return blocked;
				tx.delete(members).where(eq(members.userId, userId)).run();
				return null;
			});
			if (result === "missing") return c.json({ error: "not found" }, 404);
			if (result) return c.json({ error: result }, 409);
			return c.json({ ok: true });
		},
	);

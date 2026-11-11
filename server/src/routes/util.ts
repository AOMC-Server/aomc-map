import type { Role } from "@aomc/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { loadLayerAccess } from "../permissions";
import type { User } from "../types";

export const parseId = (value: string | undefined) =>
	/^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;

/** Loads the layer with the given id as the current actor sees it; null means answer 404. */
export const layerFor = (
	c: { var: { db: Db; user: User | null; role: Role } },
	id: string | undefined,
) => loadLayerAccess(c.var.db, c.var.user, c.var.role, parseId(id));

export const UNKNOWN_USER_ERROR =
	"user not found (they must log in once first)";

/** A user known to the server (they have logged in once), or null. */
export const findUser = (db: Db, userId: string) =>
	db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get() ??
	null;

/** Members may always remove themselves; removing anyone else takes `canManage`. */
export const mayRemove = (actor: User, targetId: string, canManage: boolean) =>
	actor.id === targetId || canManage;

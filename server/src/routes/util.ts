import type { Role } from "@aomc/shared";
import type { Db } from "../db/client";
import { loadLayerAccess } from "../permissions";
import type { User } from "../types";

export const parseId = (value: string | undefined) =>
	/^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;

/** Loads the layer with the given id as the current actor sees it; null means answer 404. */
export const layerFor = (
	c: { var: { db: Db; user: User | null; role: Role } },
	id: string | undefined,
) => loadLayerAccess(c.var.db, c.var.user, c.var.role, parseId(id));

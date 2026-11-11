import { createLayerInviteSchema, createMapInviteSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { desc, eq, isNull, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser, userOf } from "../auth/session";
import { sha256Hex } from "../auth/tokens";
import type { Db } from "../db/client";
import { invites, layers, users } from "../db/schema";
import {
	acceptInvite,
	createInvite,
	inviteStatus,
	looksLikeInviteToken,
} from "../invites";
import { atLeast, canManage, canManageLayer } from "../permissions";
import type { AppEnv } from "../types";
import { layerFor, parseId } from "./util";

type InviteRow = typeof invites.$inferSelect;

function serialize(row: InviteRow, createdByName: string) {
	return {
		id: row.id,
		kind: row.layerId === null ? ("map" as const) : ("layer" as const),
		role: row.role,
		createdBy: row.createdBy,
		createdByName,
		expiresAt: row.expiresAt,
		maxUses: row.maxUses,
		uses: row.uses,
		status: inviteStatus(row),
	};
}

const publicUrl = (
	c: { var: { env: { PUBLIC_URL: string } } },
	token: string,
) => new URL(`/invite/${token}`, c.var.env.PUBLIC_URL).toString();

async function list(db: Db, where: SQL) {
	const rows = await db
		.select({ invite: invites, creator: users.username })
		.from(invites)
		.innerJoin(users, eq(users.id, invites.createdBy))
		.where(where)
		.orderBy(desc(invites.id));
	return rows.map((r) => serialize(r.invite, r.creator));
}

/** /api/layers/:id/invites (layer managers) */
export const layerInviteRoutes = new Hono<AppEnv>()
	.get("/", requireUser, async (c) => {
		const found = await layerFor(c, c.req.param("id"));
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canManageLayer(c.var.user, c.var.role, found.layer))
			return c.json({ error: "forbidden" }, 403);
		return c.json({
			invites: await list(c.var.db, eq(invites.layerId, found.layer.id)),
		});
	})
	.post(
		"/",
		requireUser,
		zValidator("json", createLayerInviteSchema),
		async (c) => {
			const user = userOf(c);
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const { row, token } = createInvite(c.var.db, {
				...body,
				layerId: found.layer.id,
				createdBy: user.id,
			});
			return c.json(
				{
					invite: serialize(row, user.username),
					token,
					url: publicUrl(c, token),
				},
				201,
			);
		},
	);

/** /api/invites: map invites (owners), previewing and accepting by token, revoking by id */
export const inviteRoutes = new Hono<AppEnv>()
	.get("/", requireUser, async (c) => {
		if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
		return c.json({ invites: await list(c.var.db, isNull(invites.layerId)) });
	})
	.post(
		"/",
		requireUser,
		zValidator("json", createMapInviteSchema),
		async (c) => {
			const user = userOf(c);
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const { row, token } = createInvite(c.var.db, {
				...c.req.valid("json"),
				layerId: null,
				role: "moderator",
				createdBy: user.id,
			});
			return c.json(
				{
					invite: serialize(row, user.username),
					token,
					url: publicUrl(c, token),
				},
				201,
			);
		},
	)
	.get("/:token", async (c) => {
		const { db, map, role } = c.var;
		const token = c.req.param("token");
		if (!looksLikeInviteToken(token))
			return c.json({ error: "invite not found" }, 404);

		const [row] = await db
			.select()
			.from(invites)
			.where(eq(invites.tokenHash, sha256Hex(token)));
		if (!row) return c.json({ error: "invite not found" }, 404);
		const status = inviteStatus(row);
		if (status !== "active") {
			return c.json({ error: `this invite is ${status}`, reason: status }, 410);
		}

		const [layer] = row.layerId
			? await db.select().from(layers).where(eq(layers.id, row.layerId))
			: [undefined];
		if (row.layerId && (!layer || layer.deletedAt !== null)) {
			return c.json(
				{ error: "this invite is no longer valid", reason: "gone" },
				410,
			);
		}
		const [inviter] = await db
			.select({ name: users.username })
			.from(users)
			.where(eq(users.id, row.createdBy));

		return c.json({
			invite: {
				kind: row.layerId === null ? "map" : "layer",
				role: row.role,
				mapName: map.name,
				layerName: layer?.name ?? null,
				inviterName: inviter?.name ?? "someone",
				alreadyMember: row.layerId === null && atLeast(role, "moderator"),
			},
		});
	})
	.post("/:token/accept", requireUser, async (c) => {
		const token = c.req.param("token");
		if (!looksLikeInviteToken(token))
			return c.json({ error: "invite not found" }, 404);
		const result = acceptInvite(c.var.db, userOf(c).id, token);
		if (!result.ok) return c.json({ error: result.error }, result.status);
		const { ok: _ok, ...rest } = result;
		return c.json(rest);
	})
	.delete("/:id", requireUser, async (c) => {
		const { db, role } = c.var;
		const [row] = await db
			.select()
			.from(invites)
			.where(eq(invites.id, parseId(c.req.param("id"))));
		if (!row) return c.json({ error: "not found" }, 404);

		if (row.layerId !== null) {
			const found = await layerFor(c, String(row.layerId));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, role, found.layer))
				return c.json({ error: "forbidden" }, 403);
		} else if (!canManage(role)) {
			return c.json({ error: "forbidden" }, 403);
		}
		await db
			.update(invites)
			.set({ revoked: true })
			.where(eq(invites.id, row.id));
		return c.json({ ok: true });
	});

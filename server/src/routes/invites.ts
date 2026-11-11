import { createLayerInviteSchema, createMapInviteSchema } from "@aomc/shared";
import { desc, eq, isNull, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { invites, users } from "../db/schema";
import {
	acceptInvite,
	coveredBy,
	createInvite,
	inviteStatus,
	looksLikeInviteToken,
	resolveInvite,
} from "../invites";
import { doc } from "../openapi";
import { canManage, canManageLayer } from "../permissions";
import type { AppEnv } from "../types";
import { validate } from "../validate";
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
	.get(
		"/",
		doc({
			tag: "Sharing",
			summary: "List a layer's invites",
			fails: [403, 404],
			login: true,
		}),
		requireUser,
		async (c) => {
			const found = await layerFor(c, c.req.param("id"));
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayer(c.var.user, c.var.role, found.layer))
				return c.json({ error: "forbidden" }, 403);
			return c.json({
				invites: await list(c.var.db, eq(invites.layerId, found.layer.id)),
			});
		},
	)
	.post(
		"/",
		doc({
			tag: "Sharing",
			summary: "Create a layer invite",
			description: "The link is in `url` and shown once.",
			ok: { 201: "Invite created" },
			fails: [400, 403, 404, 429],
			login: true,
		}),
		requireUser,
		validate("json", createLayerInviteSchema),
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
	.get(
		"/",
		doc({
			tag: "Sharing",
			summary: "List the map's invites",
			description: "Owners.",
			fails: [403],
			login: true,
		}),
		requireUser,
		async (c) => {
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);
			return c.json({ invites: await list(c.var.db, isNull(invites.layerId)) });
		},
	)
	.post(
		"/",
		doc({
			tag: "Sharing",
			summary: "Create a map invite",
			description:
				"Owners. The invite makes the person a moderator. The link is in `url` and shown once.",
			ok: { 201: "Invite created" },
			fails: [400, 403],
			login: true,
		}),
		requireUser,
		validate("json", createMapInviteSchema),
		async (c) => {
			const user = userOf(c);
			if (!canManage(c.var.role)) return c.json({ error: "forbidden" }, 403);

			const { row, token } = createInvite(c.var.db, {
				...c.req.valid("json"),
				layerId: null,
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
	.get(
		"/:token",
		doc({
			tag: "Sharing",
			summary: "Look up an invite by its token",
			fails: [404, 410],
		}),
		async (c) => {
			const { db, map, user } = c.var;
			const token = c.req.param("token");
			if (!looksLikeInviteToken(token))
				return c.json({ error: "invite not found" }, 404);

			const found = resolveInvite(db, token);
			if (!found.ok) {
				return c.json(
					{ error: found.error, reason: found.reason },
					found.status,
				);
			}
			const { inv: row, layer } = found;
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
					alreadyMember:
						user !== null && coveredBy(db, user.id, found) !== null,
				},
			});
		},
	)
	.post(
		"/:token/accept",
		doc({
			tag: "Sharing",
			summary: "Accept an invite",
			description:
				"Never lowers anyone's role. Map invites need a browser session or a token with the `manage` scope. Answers 410 when the invite is no longer valid, including when its creator lost the right to make it.",
			fails: [403, 404, 410],
			login: true,
		}),
		requireUser,
		async (c) => {
			const token = c.req.param("token");
			if (!looksLikeInviteToken(token))
				return c.json({ error: "invite not found" }, 404);
			const { authVia, scopes } = c.var;
			const allowMap =
				authVia !== "token" || (scopes?.includes("manage") ?? false);
			const result = acceptInvite(c.var.db, userOf(c).id, token, allowMap);
			if (!result.ok) return c.json({ error: result.error }, result.status);
			const { ok: _ok, ...rest } = result;
			return c.json(rest);
		},
	)
	.delete(
		"/:id",
		doc({
			tag: "Sharing",
			summary: "Revoke an invite",
			fails: [403, 404],
			login: true,
		}),
		requireUser,
		async (c) => {
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
		},
	);

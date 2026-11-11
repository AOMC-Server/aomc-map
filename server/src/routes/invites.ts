import {
	createLayerInviteSchema,
	createMapInviteSchema,
	type Role,
} from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { sha256Hex } from "../auth/tokens";
import type { Db } from "../db/client";
import { invites, layers, maps, users } from "../db/schema";
import {
	acceptInvite,
	createInvite,
	inviteStatus,
	looksLikeInviteToken,
} from "../invites";
import {
	atLeast,
	canManageInvites,
	canManageLayerMembers,
	effectiveRole,
	loadLayerAccess,
	loadMapAccess,
	loadMapAccessById,
	loadMembership,
} from "../permissions";
import type { AppEnv } from "../types";

const parseId = (value: string | undefined) =>
	/^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;

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

async function list(db: Db, where: ReturnType<typeof eq>) {
	const rows = await db
		.select({ invite: invites, creator: users.username })
		.from(invites)
		.innerJoin(users, eq(users.id, invites.createdBy))
		.where(where)
		.orderBy(desc(invites.id));
	return rows.map((r) => serialize(r.invite, r.creator));
}

/** /api/maps/:slug/invites (map owners) */
export const mapInviteRoutes = new Hono<AppEnv>()
	.get("/", requireUser, async (c) => {
		const access = await loadMapAccess(
			c.var.db,
			c.var.user,
			c.req.param("slug") ?? "",
		);
		if (!access) return c.json({ error: "not found" }, 404);
		if (!canManageInvites(access.role))
			return c.json({ error: "forbidden" }, 403);
		return c.json({
			invites: await list(c.var.db, eq(invites.mapId, access.map.id)),
		});
	})
	.post(
		"/",
		requireUser,
		zValidator("json", createMapInviteSchema),
		async (c) => {
			const user = c.var.user as NonNullable<typeof c.var.user>;
			const access = await loadMapAccess(
				c.var.db,
				user,
				c.req.param("slug") ?? "",
			);
			if (!access) return c.json({ error: "not found" }, 404);
			if (!canManageInvites(access.role))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const { row, token } = createInvite(c.var.db, {
				mapId: access.map.id,
				role: body.role,
				createdBy: user.id,
				expiresInHours: body.expiresInHours,
				maxUses: body.maxUses,
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

/** /api/layers/:id/invites (layer managers) */
export const layerInviteRoutes = new Hono<AppEnv>()
	.get("/", requireUser, async (c) => {
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const found = await loadLayerAccess(
			c.var.db,
			user,
			parseId(c.req.param("id")),
		);
		if (!found) return c.json({ error: "not found" }, 404);
		if (!canManageLayerMembers(user, found.role, found.layer))
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
			const user = c.var.user as NonNullable<typeof c.var.user>;
			const found = await loadLayerAccess(
				c.var.db,
				user,
				parseId(c.req.param("id")),
			);
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayerMembers(user, found.role, found.layer))
				return c.json({ error: "forbidden" }, 403);

			const body = c.req.valid("json");
			const { row, token } = createInvite(c.var.db, {
				layerId: found.layer.id,
				role: body.role,
				createdBy: user.id,
				expiresInHours: body.expiresInHours,
				maxUses: body.maxUses,
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

/** /api/invites: previewing and accepting by token, revoking by id */
export const inviteRoutes = new Hono<AppEnv>()
	.get("/:token", async (c) => {
		const { db, user } = c.var;
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
		const mapId = row.mapId ?? layer?.mapId;
		const [map] = mapId
			? await db.select().from(maps).where(eq(maps.id, mapId))
			: [undefined];
		if (!map || (row.layerId && (!layer || layer.deletedAt !== null))) {
			return c.json(
				{ error: "this invite is no longer valid", reason: "gone" },
				410,
			);
		}
		const [inviter] = await db
			.select({ name: users.username })
			.from(users)
			.where(eq(users.id, row.createdBy));

		let alreadyMember = false;
		if (user) {
			const current = effectiveRole(
				user,
				map,
				await loadMembership(db, map.id, user.id),
			);
			alreadyMember =
				row.layerId === null && atLeast(current, row.role as Role);
		}
		return c.json({
			invite: {
				kind: row.layerId === null ? "map" : "layer",
				role: row.role,
				mapName: map.name,
				mapSlug: map.slug,
				layerName: layer?.name ?? null,
				inviterName: inviter?.name ?? "someone",
				alreadyMember,
			},
		});
	})
	.post("/:token/accept", requireUser, async (c) => {
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const token = c.req.param("token");
		if (!looksLikeInviteToken(token))
			return c.json({ error: "invite not found" }, 404);
		const result = acceptInvite(c.var.db, user.id, token);
		if (!result.ok) return c.json({ error: result.error }, result.status);
		const { ok: _ok, ...rest } = result;
		return c.json(rest);
	})
	.delete("/:id", requireUser, async (c) => {
		const { db } = c.var;
		const user = c.var.user as NonNullable<typeof c.var.user>;
		const [row] = await db
			.select()
			.from(invites)
			.where(eq(invites.id, parseId(c.req.param("id"))));
		if (!row) return c.json({ error: "not found" }, 404);

		if (row.layerId !== null) {
			const found = await loadLayerAccess(db, user, row.layerId);
			if (!found) return c.json({ error: "not found" }, 404);
			if (!canManageLayerMembers(user, found.role, found.layer))
				return c.json({ error: "forbidden" }, 403);
		} else {
			const access = await loadMapAccessById(db, user, row.mapId as number);
			if (!access) return c.json({ error: "not found" }, 404);
			if (!canManageInvites(access.role))
				return c.json({ error: "forbidden" }, 403);
		}
		await db
			.update(invites)
			.set({ revoked: true })
			.where(eq(invites.id, row.id));
		return c.json({ ok: true });
	});

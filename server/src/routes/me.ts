import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { deleteAccount, exportAccount } from "../account";
import { announceEverything } from "../announce";
import { requireUser, SESSION_COOKIE, userOf } from "../auth/session";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

export const meRoutes = new Hono<AppEnv>()
	.get(
		"/",
		doc({
			tag: "Session",
			summary: "Get the current user",
			description:
				"`user` is null when not logged in. `scopes` lists an API token's scopes, and is null for a browser session.",
		}),
		(c) => c.json({ user: c.var.user, scopes: c.var.scopes }),
	)
	.get(
		"/export",
		doc({
			tag: "Session",
			summary: "Download your data",
			description:
				"Everything stored about you, as a JSON file: your account, roles, tokens (without their secrets), uploads, layers, feature edits, invites and short links.",
			login: true,
		}),
		requireUser,
		(c) => {
			const data = exportAccount(c.var.db, userOf(c).id);
			if (!data) return c.json({ error: "not found" }, 404);
			c.header(
				"Content-Disposition",
				'attachment; filename="my-map-data.json"',
			);
			c.header("Cache-Control", "no-store");
			return c.json(data);
		},
	)
	.delete(
		"/",
		doc({
			tag: "Session",
			summary: "Delete your account",
			description:
				"Needs a browser session. Removes your login, sessions, API tokens, roles, layer memberships and the invites you made. Your uploads, layers and features stay on the map under the name “Deleted user”, with nothing left that identifies you. The map's last owner cannot delete their account.",
			fails: [403, 409],
			login: true,
		}),
		requireUser,
		(c) => {
			if (c.var.authVia !== "session")
				return c.json({ error: "log in to delete your account" }, 403);
			const result = deleteAccount(c.var.db, userOf(c).id);
			if (result === "last owner")
				return c.json(
					{
						error:
							"you are the map's last owner: make someone else an owner first",
					},
					409,
				);
			announceEverything(c);
			deleteCookie(c, SESSION_COOKIE, { path: "/" });
			return c.json({ ok: true });
		},
	);

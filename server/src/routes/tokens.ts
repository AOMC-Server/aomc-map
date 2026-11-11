import { createTokenSchema, MAX_TOKENS_PER_USER } from "@aomc/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { validator } from "hono-openapi";
import { requireUser } from "../auth/session";
import {
	createApiTokenWithLimit,
	deleteApiToken,
	listApiTokens,
} from "../auth/tokens";
import { doc } from "../openapi";
import type { AppEnv } from "../types";
import { parseId } from "./util";

/** A token must not be able to list, mint or revoke tokens, so a leaked one stays contained. */
const requireSession = createMiddleware<AppEnv>(async (c, next) => {
	if (c.var.authVia !== "session") {
		return c.json({ error: "log in to manage API tokens" }, 403);
	}
	return next();
});

export const tokenRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.use(requireSession)
	.get(
		"/",
		doc({
			tag: "Session",
			summary: "List your API tokens",
			description: "Needs a browser session.",
			fails: [403],
			login: true,
		}),
		async (c) =>
			c.json({ tokens: await listApiTokens(c.var.db, c.var.user!.id) }),
	)
	.post(
		"/",
		doc({
			tag: "Session",
			summary: "Create an API token",
			description:
				"Needs a browser session; a token cannot create tokens. The secret is only in this response. `scopes` defaults to read, upload and features; `manage` implies `moderate`.",
			ok: { 201: "Token created" },
			fails: [403, 409],
			login: true,
		}),
		validator("json", createTokenSchema),
		async (c) => {
			const { name, expiresInDays, scopes } = c.req.valid("json");
			const created = createApiTokenWithLimit(c.var.db, MAX_TOKENS_PER_USER, {
				userId: c.var.user!.id,
				name,
				expiresInDays,
				scopes,
			});
			if (!created) {
				return c.json(
					{ error: `at most ${MAX_TOKENS_PER_USER} tokens; revoke one first` },
					409,
				);
			}
			return c.json(created, 201);
		},
	)
	.delete(
		"/:id",
		doc({
			tag: "Session",
			summary: "Revoke an API token",
			description: "Needs a browser session.",
			fails: [403, 404],
			login: true,
		}),
		async (c) => {
			const ok = await deleteApiToken(
				c.var.db,
				c.var.user!.id,
				parseId(c.req.param("id")),
			);
			return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
		},
	);

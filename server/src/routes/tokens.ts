import { createTokenSchema, MAX_TOKENS_PER_USER } from "@aomc/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { validator } from "hono-openapi";
import { requireUser } from "../auth/session";
import {
	countApiTokens,
	createApiToken,
	deleteApiToken,
	listApiTokens,
} from "../auth/tokens";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

/** A token must not be able to mint or revoke tokens, so a leaked one stays contained. */
const requireSession = createMiddleware<AppEnv>(async (c, next) => {
	if (c.var.authVia !== "session") {
		return c.json({ error: "log in to manage API tokens" }, 403);
	}
	return next();
});

export const tokenRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get(
		"/",
		doc({ tag: "Session", summary: "List your API tokens", login: true }),
		async (c) =>
			c.json({ tokens: await listApiTokens(c.var.db, c.var.user!.id) }),
	)
	.post(
		"/",
		doc({
			tag: "Session",
			summary: "Create an API token",
			description:
				"Needs a browser session; a token cannot create tokens. The secret is only in this response.",
			ok: { 201: "Token created" },
			fails: [403, 409],
			login: true,
		}),
		requireSession,
		validator("json", createTokenSchema),
		async (c) => {
			const userId = c.var.user!.id;
			if ((await countApiTokens(c.var.db, userId)) >= MAX_TOKENS_PER_USER) {
				return c.json(
					{ error: `at most ${MAX_TOKENS_PER_USER} tokens; revoke one first` },
					409,
				);
			}
			const { name, expiresInDays } = c.req.valid("json");
			return c.json(
				await createApiToken(c.var.db, userId, name, expiresInDays),
				201,
			);
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
		requireSession,
		async (c) => {
			const ok = await deleteApiToken(
				c.var.db,
				c.var.user!.id,
				Number(c.req.param("id")),
			);
			return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
		},
	);

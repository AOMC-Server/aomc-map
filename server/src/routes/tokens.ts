import { createTokenSchema, MAX_TOKENS_PER_USER } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { requireUser } from "../auth/session";
import {
	countApiTokens,
	createApiToken,
	deleteApiToken,
	listApiTokens,
} from "../auth/tokens";
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
	.get("/", async (c) =>
		c.json({ tokens: await listApiTokens(c.var.db, c.var.user!.id) }),
	)
	.post(
		"/",
		requireSession,
		zValidator("json", createTokenSchema),
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
	.delete("/:id", requireSession, async (c) => {
		const ok = await deleteApiToken(
			c.var.db,
			c.var.user!.id,
			Number(c.req.param("id")),
		);
		return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
	});

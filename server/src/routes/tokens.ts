import { createTokenSchema } from "@aomc/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireUser } from "../auth/session";
import { createApiToken, deleteApiToken, listApiTokens } from "../auth/tokens";
import type { AppEnv } from "../types";

export const tokenRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get("/", async (c) =>
		c.json({ tokens: await listApiTokens(c.var.db, c.var.user!.id) }),
	)
	.post("/", zValidator("json", createTokenSchema), async (c) => {
		const created = await createApiToken(
			c.var.db,
			c.var.user!.id,
			c.req.valid("json").name,
		);
		return c.json(created, 201);
	})
	.delete("/:id", async (c) => {
		const ok = await deleteApiToken(
			c.var.db,
			c.var.user!.id,
			Number(c.req.param("id")),
		);
		return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
	});

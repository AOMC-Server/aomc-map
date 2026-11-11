import { Hono } from "hono";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

export const meRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Session",
		summary: "Get the current user",
		description:
			"`user` is null when not logged in. `scopes` lists an API token's scopes, and is null for a browser session.",
	}),
	(c) => c.json({ user: c.var.user, scopes: c.var.scopes }),
);

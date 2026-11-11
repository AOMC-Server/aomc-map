import { Hono } from "hono";
import { doc } from "../openapi";
import type { AppEnv } from "../types";

export const meRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Session",
		summary: "Get the current user",
		description: "`user` is null when not logged in.",
	}),
	(c) => c.json({ user: c.var.user }),
);

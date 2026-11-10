import { Hono } from "hono";
import type { AppEnv } from "../types";

export const meRoutes = new Hono<AppEnv>().get("/", (c) =>
	c.json({ user: c.var.user }),
);

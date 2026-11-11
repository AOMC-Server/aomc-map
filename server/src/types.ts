import type { Role } from "@aomc/shared";
import type { Db } from "./db/client";
import type { mapInfo } from "./db/schema";
import type { Env } from "./env";
import type { Services } from "./services";

export type User = {
	id: string;
	username: string;
	avatarUrl: string | null;
};

export type MapRow = typeof mapInfo.$inferSelect;

export type AppEnv = {
	Variables: {
		db: Db;
		env: Env;
		svc: Services;
		user: User | null;
		authVia: "session" | "token" | null;
		/** Set for every /api request. */
		map: MapRow;
		role: Role;
	};
};

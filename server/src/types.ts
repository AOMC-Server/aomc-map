import type { Role, TokenScope } from "@aomc/shared";
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
		/** The API token's scopes; null unless authVia is "token". */
		scopes: TokenScope[] | null;
		/** Set for every /api request. */
		map: MapRow;
		role: Role;
		/** The map is in maintenance and the actor is not an owner: every map write is refused. */
		readOnly: boolean;
	};
};

import type { Db } from "./db/client";
import type { Env } from "./env";
import type { Services } from "./services";

export type User = {
	id: string;
	username: string;
	avatarUrl: string | null;
};

export type AppEnv = {
	Variables: {
		db: Db;
		env: Env;
		svc: Services;
		user: User | null;
		authVia: "session" | "token" | null;
	};
};

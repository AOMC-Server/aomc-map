import type { Db } from "./db/client";
import type { Env } from "./env";

export type User = {
	id: string;
	username: string;
	avatarUrl: string | null;
};

export type AppEnv = {
	Variables: {
		db: Db;
		env: Env;
		user: User | null;
		authVia: "session" | "token" | null;
	};
};

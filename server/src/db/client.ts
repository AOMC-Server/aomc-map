import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(path: string) {
	const sqlite = new Database(path, { create: true, strict: true });
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run("PRAGMA foreign_keys = ON");
	sqlite.run("PRAGMA busy_timeout = 5000");
	return drizzle(sqlite, { schema });
}

export function runMigrations(db: Db) {
	migrate(db, { migrationsFolder: `${import.meta.dir}/migrations` });
}

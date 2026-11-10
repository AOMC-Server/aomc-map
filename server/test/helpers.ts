import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createSession } from "../src/auth/session";
import { createApiToken } from "../src/auth/tokens";
import { createDb, runMigrations } from "../src/db/client";
import { users } from "../src/db/schema";
import { parseEnv } from "../src/env";

export function makeTestApp(
	envOverrides: Record<string, string> = {},
	fetchFn?: typeof fetch,
) {
	const dir = mkdtempSync(join(tmpdir(), "aomc-test-"));
	const db = createDb(join(dir, "db.sqlite"));
	runMigrations(db);
	const env = parseEnv({
		DATA_DIR: dir,
		PUBLIC_URL: "http://localhost:3000",
		...envOverrides,
	});
	const app = createApp({ db, env, fetch: fetchFn });
	return { app, db, env };
}

export async function makeUser(
	db: ReturnType<typeof createDb>,
	id: string,
	username = id,
) {
	await db.insert(users).values({ id, username, lastLoginAt: Date.now() });
	const { token } = await createApiToken(db, id, "test");
	return { id, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeSessionCookie(
	db: ReturnType<typeof createDb>,
	userId: string,
) {
	return `aomc_session=${await createSession(db, userId)}`;
}

export const json = (body: unknown) => ({
	body: JSON.stringify(body),
	headers: { "Content-Type": "application/json" },
});

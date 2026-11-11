import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { apiTokens, users } from "../db/schema";
import type { User } from "../types";

const TOKEN_PREFIX = "aomc_";

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Returns the plaintext token once; only its hash is stored. */
export async function createApiToken(db: Db, userId: string, name: string) {
	const token = TOKEN_PREFIX + randomToken(24);
	const [row] = await db
		.insert(apiTokens)
		.values({ userId, name, tokenHash: sha256Hex(token) })
		.returning({
			id: apiTokens.id,
			name: apiTokens.name,
			createdAt: apiTokens.createdAt,
		});
	return { ...row, token };
}

export function listApiTokens(db: Db, userId: string) {
	return db
		.select({
			id: apiTokens.id,
			name: apiTokens.name,
			createdAt: apiTokens.createdAt,
			lastUsedAt: apiTokens.lastUsedAt,
		})
		.from(apiTokens)
		.where(eq(apiTokens.userId, userId))
		.all();
}

export async function deleteApiToken(
	db: Db,
	userId: string,
	id: number,
): Promise<boolean> {
	const rows = await db
		.delete(apiTokens)
		.where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
		.returning({ id: apiTokens.id });
	return rows.length > 0;
}

export async function verifyApiToken(
	db: Db,
	token: string,
): Promise<User | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const [row] = await db
		.select({
			tokenId: apiTokens.id,
			id: users.id,
			username: users.username,
			avatarUrl: users.avatarUrl,
		})
		.from(apiTokens)
		.innerJoin(users, eq(users.id, apiTokens.userId))
		.where(eq(apiTokens.tokenHash, sha256Hex(token)));
	if (!row) return null;
	await db
		.update(apiTokens)
		.set({ lastUsedAt: Date.now() })
		.where(eq(apiTokens.id, row.tokenId));
	return { id: row.id, username: row.username, avatarUrl: row.avatarUrl };
}

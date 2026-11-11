import { createHash, randomBytes } from "node:crypto";
import { DAY, MINUTE, TOKEN_SCOPES, type TokenScope } from "@aomc/shared";
import { and, count, eq } from "drizzle-orm";
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

const LAST_USED_GRANULARITY_MS = MINUTE;

type NewToken = {
	userId: string;
	name: string;
	expiresInDays: number | null;
	scopes: TokenScope[];
};

function insertApiToken(
	db: Pick<Db, "insert">,
	{ userId, name, expiresInDays, scopes }: NewToken,
) {
	const token = TOKEN_PREFIX + randomToken(24);
	const row = db
		.insert(apiTokens)
		.values({
			userId,
			name,
			tokenHash: sha256Hex(token),
			expiresAt:
				expiresInDays === null ? null : Date.now() + expiresInDays * DAY,
			scopes,
		})
		.returning({
			id: apiTokens.id,
			name: apiTokens.name,
			createdAt: apiTokens.createdAt,
			expiresAt: apiTokens.expiresAt,
			scopes: apiTokens.scopes,
		})
		.get();
	if (!row) throw new Error("token insert returned no row");
	return { ...row, token };
}

/** Returns the plaintext token once; only its hash is stored. `expiresInDays` null = never. */
export async function createApiToken(
	db: Db,
	userId: string,
	name: string,
	expiresInDays: number | null = null,
	scopes: TokenScope[] = [...TOKEN_SCOPES],
) {
	return insertApiToken(db, { userId, name, expiresInDays, scopes });
}

/** Like createApiToken, but counts and inserts in one transaction; null if the user is at `max`. */
export function createApiTokenWithLimit(db: Db, max: number, token: NewToken) {
	return db.transaction(
		(tx) => {
			const [row] = tx
				.select({ n: count() })
				.from(apiTokens)
				.where(eq(apiTokens.userId, token.userId))
				.all();
			return (row?.n ?? 0) >= max ? null : insertApiToken(tx, token);
		},
		{ behavior: "immediate" },
	);
}

export function listApiTokens(db: Db, userId: string) {
	return db
		.select({
			id: apiTokens.id,
			name: apiTokens.name,
			createdAt: apiTokens.createdAt,
			lastUsedAt: apiTokens.lastUsedAt,
			expiresAt: apiTokens.expiresAt,
			scopes: apiTokens.scopes,
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
): Promise<{ user: User; scopes: TokenScope[] } | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const [row] = await db
		.select({
			tokenId: apiTokens.id,
			expiresAt: apiTokens.expiresAt,
			lastUsedAt: apiTokens.lastUsedAt,
			scopes: apiTokens.scopes,
			id: users.id,
			username: users.username,
			avatarUrl: users.avatarUrl,
		})
		.from(apiTokens)
		.innerJoin(users, eq(users.id, apiTokens.userId))
		.where(eq(apiTokens.tokenHash, sha256Hex(token)));
	if (!row) return null;
	const now = Date.now();
	if (row.expiresAt !== null && row.expiresAt <= now) return null;
	// A write per request would make every API call a write; a minute is fine for "last used".
	if (
		row.lastUsedAt === null ||
		now - row.lastUsedAt >= LAST_USED_GRANULARITY_MS
	) {
		await db
			.update(apiTokens)
			.set({ lastUsedAt: now })
			.where(eq(apiTokens.id, row.tokenId));
	}
	return {
		user: { id: row.id, username: row.username, avatarUrl: row.avatarUrl },
		scopes: row.scopes,
	};
}

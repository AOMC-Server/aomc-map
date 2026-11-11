import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { dimensions, mapInfo, members, pendingOwners } from "./db/schema";
import type { Env } from "./env";

/** scale: overworld blocks per block of that dimension; null = coordinates are unrelated. */
const DEFAULT_DIMENSIONS = [
	{ slug: "overworld", name: "Overworld", scale: 1, theme: "overworld" },
	{ slug: "nether", name: "Nether", scale: 8, theme: "nether" },
	{ slug: "the_end", name: "The End", scale: null, theme: "end" },
] as const;

/** Creates the map on first run. Safe to call on every boot. */
export function runSetup(db: Db, env: Env) {
	if (db.select().from(mapInfo).get()) return;

	db.transaction((tx) => {
		tx.insert(mapInfo)
			.values({
				id: 1,
				name: env.SETUP_MAP_NAME,
				tileSize: env.DEFAULT_TILE_SIZE,
			})
			.run();
		tx.insert(dimensions)
			.values(DEFAULT_DIMENSIONS.map((d, i) => ({ ...d, sortOrder: i })))
			.run();
		if (env.SETUP_OWNER_DISCORD_IDS.length > 0) {
			tx.insert(pendingOwners)
				.values(env.SETUP_OWNER_DISCORD_IDS.map((discordId) => ({ discordId })))
				.onConflictDoNothing()
				.run();
		}
	});
}

/** Turns a pending_owners row for this Discord id into an owner membership. */
export function applyPendingOwners(db: Db, userId: string) {
	db.transaction((tx) => {
		const pending = tx
			.delete(pendingOwners)
			.where(eq(pendingOwners.discordId, userId))
			.returning()
			.all();
		if (pending.length > 0) {
			tx.insert(members)
				.values({ userId, role: "owner" })
				.onConflictDoUpdate({ target: members.userId, set: { role: "owner" } })
				.run();
		}
	});
}

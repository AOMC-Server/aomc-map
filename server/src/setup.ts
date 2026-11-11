import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { dimensions, mapMembers, maps, pendingOwners } from "./db/schema";
import type { Env } from "./env";

/** scale: overworld blocks per block of that dimension; null = coordinates are unrelated. */
const DEFAULT_DIMENSIONS = [
	{ slug: "overworld", name: "Overworld", scale: 1 },
	{ slug: "overworld_caves", name: "Overworld Caves", scale: 1 },
	{ slug: "nether", name: "Nether", scale: 8 },
	{ slug: "the_end", name: "The End", scale: null },
];

/** Creates the map on first run. Safe to call on every boot. */
export async function runSetup(db: Db, env: Env) {
	const [existing] = await db.select({ id: maps.id }).from(maps).limit(1);
	if (existing) return;

	db.transaction((tx) => {
		const map = tx
			.insert(maps)
			.values({
				slug: env.SETUP_MAP_SLUG,
				name: env.SETUP_MAP_NAME,
				tileSize: env.DEFAULT_TILE_SIZE,
			})
			.returning({ id: maps.id })
			.get();
		tx.insert(dimensions)
			.values(
				DEFAULT_DIMENSIONS.map((d, i) => ({
					...d,
					mapId: map.id,
					sortOrder: i,
				})),
			)
			.run();
		if (env.SETUP_OWNER_DISCORD_IDS.length > 0) {
			tx.insert(pendingOwners)
				.values(
					env.SETUP_OWNER_DISCORD_IDS.map((discordId) => ({
						mapId: map.id,
						discordId,
					})),
				)
				.onConflictDoNothing()
				.run();
		}
	});
}

/** Turns pending_owners rows for this Discord id into owner memberships. */
export async function applyPendingOwners(db: Db, userId: string) {
	db.transaction((tx) => {
		const pending = tx
			.select()
			.from(pendingOwners)
			.where(eq(pendingOwners.discordId, userId))
			.all();
		for (const p of pending) {
			tx.insert(mapMembers)
				.values({ mapId: p.mapId, userId, role: "owner" })
				.onConflictDoUpdate({
					target: [mapMembers.mapId, mapMembers.userId],
					set: { role: "owner" },
				})
				.run();
		}
		tx.delete(pendingOwners).where(eq(pendingOwners.discordId, userId)).run();
	});
}

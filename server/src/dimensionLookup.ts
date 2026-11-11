import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { dimensions } from "./db/schema";

export function dimensionBySlug(db: Pick<Db, "select">, slug: string) {
	return db.select().from(dimensions).where(eq(dimensions.slug, slug)).get();
}

/** The first dimension in the map's order that is not archived. */
export function defaultDimension(db: Pick<Db, "select">) {
	return db
		.select()
		.from(dimensions)
		.where(eq(dimensions.archived, false))
		.orderBy(dimensions.sortOrder, dimensions.id)
		.limit(1)
		.get();
}

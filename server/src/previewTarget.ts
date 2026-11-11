import { MAX_COORD } from "@aomc/shared/schemas";
import { MIN_ZOOM } from "@aomc/shared/view";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client";
import { dimensions, maps } from "./db/schema";
import type { Env } from "./env";
import { type Actor, loadMapAccess } from "./permissions";
import type { PreviewParams } from "./preview";

const coord = z.coerce.number().int().min(-MAX_COORD).max(MAX_COORD);

/** The view parameters shared by /api/preview.png and the page's share tags. */
export const viewQuerySchema = z.object({
	map: z.string().max(40).optional(),
	dim: z.string().max(40).optional(),
	x: coord.optional(),
	z: coord.optional(),
	zoom: z.coerce.number().finite().optional(),
	rev: z.coerce.number().int().min(0).optional(),
});
export type ViewQuery = z.infer<typeof viewQuerySchema>;

export type PreviewTarget = {
	mapName: string;
	mapSlug: string;
	isPublic: boolean;
	dimensionName: string;
	dimensionSlug: string;
	mapId: number;
	params: PreviewParams;
};

/**
 * Resolves a view query to a concrete map, dimension, position and revision for the given actor.
 * Returns null when the map does not exist or the actor may not see it (callers answer 404).
 */
export async function resolvePreviewTarget(
	db: Db,
	env: Env,
	actor: Actor,
	q: ViewQuery,
): Promise<PreviewTarget | null> {
	let slug = q.map;
	if (!slug) {
		const [def] = await db
			.select({ slug: maps.slug })
			.from(maps)
			.where(eq(maps.isDefault, true));
		slug = def?.slug;
	}
	if (!slug) return null;
	const access = await loadMapAccess(db, actor, slug);
	if (!access) return null;

	const dims = await db
		.select()
		.from(dimensions)
		.where(eq(dimensions.mapId, access.map.id))
		.orderBy(dimensions.sortOrder, dimensions.id);
	const dim = q.dim
		? dims.find((d) => d.slug === q.dim)
		: dims.find((d) => !d.archived);
	if (!dim) return null;

	const zoom =
		Math.round(Math.min(Math.max(q.zoom ?? 2, MIN_ZOOM), env.MAX_ZOOM) * 100) /
		100;
	return {
		mapName: access.map.name,
		mapSlug: access.map.slug,
		isPublic: access.map.visibility === "public",
		dimensionName: dim.name,
		dimensionSlug: dim.slug,
		mapId: access.map.id,
		params: {
			dimensionId: dim.id,
			tileSize: access.map.tileSize,
			maxZoom: env.MAX_ZOOM,
			x: q.x ?? 0,
			z: q.z ?? 0,
			zoom,
			rev: Math.min(q.rev ?? access.map.headRev, access.map.headRev),
		},
	};
}

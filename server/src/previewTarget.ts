import { blockCoord } from "@aomc/shared/schemas";
import { MIN_ZOOM } from "@aomc/shared/view";
import { z } from "zod";
import type { Db } from "./db/client";
import { defaultDimension, dimensionBySlug } from "./dimensionLookup";
import type { Env } from "./env";
import type { PreviewParams } from "./preview";
import type { MapRow } from "./types";

const coord = z.coerce.number().pipe(blockCoord);

/** The view parameters shared by /api/preview.png and the page's share tags. */
export const viewQuerySchema = z.object({
	dim: z.string().max(40).optional(),
	x: coord.optional(),
	z: coord.optional(),
	zoom: z.coerce.number().finite().optional(),
	rev: z.coerce.number().int().min(0).optional(),
});
export type ViewQuery = z.infer<typeof viewQuerySchema>;

export type PreviewTarget = {
	mapName: string;
	dimensionName: string;
	dimensionSlug: string;
	params: PreviewParams;
};

/**
 * Resolves a view query to a concrete dimension, position and revision.
 * Returns null when the dimension does not exist (callers answer 404).
 */
export async function resolvePreviewTarget(
	db: Db,
	env: Env,
	map: MapRow,
	q: ViewQuery,
): Promise<PreviewTarget | null> {
	const dim = q.dim ? dimensionBySlug(db, q.dim) : defaultDimension(db);
	if (!dim) return null;

	const zoom =
		Math.round(Math.min(Math.max(q.zoom ?? 2, MIN_ZOOM), env.MAX_ZOOM) * 100) /
		100;
	return {
		mapName: map.name,
		dimensionName: dim.name,
		dimensionSlug: dim.slug,
		params: {
			dimensionId: dim.id,
			tileSize: map.tileSize,
			maxZoom: env.MAX_ZOOM,
			x: q.x ?? 0,
			z: q.z ?? 0,
			zoom,
			rev: Math.min(q.rev ?? map.headRev, map.headRev),
			epoch: map.epoch,
		},
	};
}

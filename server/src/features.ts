import type { FeatureInput } from "@aomc/shared";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { featureRevisions, features } from "./db/schema";

export type FeatureView = {
	id: number;
	layerId: number;
	revisionId: number;
	type: "pin" | "line" | "polygon";
	name: string;
	popup: string;
	color: string | null;
	geometry: unknown;
	authorId: string;
	updatedAt: number;
};

const viewFields = {
	id: features.id,
	layerId: features.layerId,
	revisionId: featureRevisions.id,
	type: featureRevisions.type,
	name: featureRevisions.name,
	popup: featureRevisions.popup,
	color: featureRevisions.color,
	geometry: featureRevisions.geometry,
	authorId: featureRevisions.authorId,
	updatedAt: featureRevisions.createdAt,
};

/**
 * Current (or as-of `at`, a unix ms timestamp) non-deleted features of the given layers.
 * A feature's state is its latest revision at that time.
 */
export async function featuresOfLayers(
	db: Db,
	layerIds: number[],
	at: number | null = null,
): Promise<Map<number, FeatureView[]>> {
	const byLayer = new Map<number, FeatureView[]>(
		layerIds.map((id) => [id, []]),
	);
	if (layerIds.length === 0) return byLayer;

	const latest = db
		.select({ id: sql<number>`max(${featureRevisions.id})` })
		.from(featureRevisions)
		.where(
			and(
				inArray(
					featureRevisions.featureId,
					db
						.select({ id: features.id })
						.from(features)
						.where(inArray(features.layerId, layerIds)),
				),
				at === null ? undefined : lte(featureRevisions.createdAt, at),
			),
		)
		.groupBy(featureRevisions.featureId);

	const rows = await db
		.select(viewFields)
		.from(featureRevisions)
		.innerJoin(features, eq(features.id, featureRevisions.featureId))
		.where(
			and(
				inArray(features.layerId, layerIds),
				inArray(featureRevisions.id, latest),
				eq(featureRevisions.deleted, false),
			),
		)
		.orderBy(features.id);
	for (const row of rows) byLayer.get(row.layerId)?.push(row);
	return byLayer;
}

/** Latest revision of a feature, including deleted state. */
export async function latestRevision(db: Db, featureId: number) {
	const [row] = await db
		.select()
		.from(featureRevisions)
		.where(eq(featureRevisions.featureId, featureId))
		.orderBy(desc(featureRevisions.id))
		.limit(1);
	return row;
}

export type RevisionContent = FeatureInput & { deleted?: boolean };

type RevisionRow = typeof featureRevisions.$inferSelect;

/** The editable fields of a revision, as FeatureInput. */
export const contentOf = (
	r: Pick<FeatureView, "type" | "name" | "popup" | "color" | "geometry">,
) =>
	({
		type: r.type,
		name: r.name,
		popup: r.popup,
		color: r.color,
		geometry: r.geometry,
	}) as FeatureInput;

export function toView(
	feature: { id: number; layerId: number },
	r: RevisionRow,
): FeatureView {
	return {
		id: feature.id,
		layerId: feature.layerId,
		revisionId: r.id,
		type: r.type,
		name: r.name,
		popup: r.popup,
		color: r.color,
		geometry: r.geometry,
		authorId: r.authorId,
		updatedAt: r.createdAt,
	};
}

export function insertRevision(
	db: Pick<Db, "insert">,
	featureId: number,
	authorId: string,
	content: RevisionContent,
) {
	return db
		.insert(featureRevisions)
		.values({
			featureId,
			authorId,
			deleted: content.deleted ?? false,
			type: content.type,
			name: content.name,
			popup: content.popup,
			color: content.color,
			geometry: content.geometry,
		})
		.returning()
		.get();
}

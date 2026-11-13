import {
	cleanStyle,
	type FeatureInput,
	type FeatureStyle,
	type FeatureType,
} from "@aomc/shared";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { featureRevisions, features } from "./db/schema";

export type FeatureView = {
	id: number;
	layerId: number;
	revisionId: number;
	type: FeatureType;
	name: string;
	popup: string;
	color: string | null;
	/** How a line or an area is drawn; null: the defaults. */
	style: FeatureStyle | null;
	geometry: unknown;
	authorId: string;
	updatedAt: number;
};

type RevisionRow = typeof featureRevisions.$inferSelect;

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
		style: r.style,
		geometry: r.geometry,
		authorId: r.authorId,
		updatedAt: r.createdAt,
	};
}

/**
 * Current (or as-of `at`, a unix ms timestamp) non-deleted features of the given layers.
 * A feature's state is its latest revision at that time.
 */
export function featuresOfLayers(
	db: Pick<Db, "select">,
	layerIds: number[],
	at: number | null = null,
): Map<number, FeatureView[]> {
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

	const rows = db
		.select({ feature: features, revision: featureRevisions })
		.from(featureRevisions)
		.innerJoin(features, eq(features.id, featureRevisions.featureId))
		.where(
			and(
				inArray(features.layerId, layerIds),
				inArray(featureRevisions.id, latest),
				eq(featureRevisions.deleted, false),
			),
		)
		.orderBy(features.sortOrder, features.id)
		.all();
	for (const { feature, revision } of rows)
		byLayer.get(feature.layerId)?.push(toView(feature, revision));
	return byLayer;
}

/** The `sortOrder` for a feature added to the end of a layer. */
export function nextFeatureOrder(db: Pick<Db, "select">, layerId: number) {
	const row = db
		.select({ max: sql<number | null>`max(${features.sortOrder})` })
		.from(features)
		.where(eq(features.layerId, layerId))
		.get();
	return (row?.max ?? 0) + 1;
}

/** Latest revision of a feature, including deleted state. */
export function latestRevision(db: Pick<Db, "select">, featureId: number) {
	return db
		.select()
		.from(featureRevisions)
		.where(eq(featureRevisions.featureId, featureId))
		.orderBy(desc(featureRevisions.id))
		.limit(1)
		.get();
}

/** How many features of a layer are not deleted. */
export function liveFeatureCount(db: Pick<Db, "all">, layerId: number) {
	const [row] = db.all<{ n: number }>(sql`
		SELECT COUNT(*) AS n FROM features f WHERE f.layer_id = ${layerId} AND NOT COALESCE(
			(SELECT r.deleted FROM feature_revisions r WHERE r.feature_id = f.id ORDER BY r.id DESC LIMIT 1), 1)`);
	return row?.n ?? 0;
}

export type RevisionContent = FeatureInput & { deleted?: boolean };

/** The editable fields of a revision, as FeatureInput. */
export const contentOf = (
	r: Pick<
		FeatureView,
		"type" | "name" | "popup" | "color" | "style" | "geometry"
	>,
) =>
	({
		type: r.type,
		name: r.name,
		popup: r.popup,
		color: r.color,
		// Only lines and areas have a style.
		...(r.type === "pin" ? {} : { style: r.style }),
		geometry: r.geometry,
	}) as FeatureInput;

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
			// Only lines and areas have a style, and an empty one is none.
			style:
				content.type === "pin"
					? null
					: cleanStyle("style" in content ? content.style : null),
			geometry: content.geometry,
		})
		.returning()
		.get();
}

/** Adds a feature at `sortOrder` with its first revision. */
export function insertFeature(
	db: Pick<Db, "insert">,
	layerId: number,
	sortOrder: number,
	authorId: string,
	content: RevisionContent,
) {
	const feature = db
		.insert(features)
		.values({ layerId, sortOrder })
		.returning()
		.get();
	return toView(feature, insertRevision(db, feature.id, authorId, content));
}

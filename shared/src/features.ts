import { z } from "zod";
import { DYES } from "./colors";
import { blockCoord, MAX_NAME, nonEmpty } from "./schemas";

export { MAX_NAME };
export const MAX_POPUP = 2000;
export const MAX_VERTICES = 2000;
export const MAX_FEATURES_PER_LAYER = 5000;
/** Live (not deleted) layers one user may have created; moderators are exempt. */
export const MAX_LAYERS_PER_USER = 50;
/** Largest JSON request body the server takes (uploads have their own limit). */
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
/** Entries of a feature's history per request unless asked for fewer. */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

export const FEATURE_TYPES = ["pin", "line", "polygon"] as const;

export const dyeSchema = z.enum(DYES);

/** [x, z] in block coordinates. */
export const pointSchema = z.tuple([blockCoord, blockCoord]);
export type Point = z.infer<typeof pointSchema>;

const distinctPoints = (points: Point[]) =>
	new Set(points.map((p) => `${p[0]},${p[1]}`)).size;

/** Twice the signed area, exact for any coordinates. */
function doubleArea(points: Point[]): bigint {
	let sum = 0n;
	for (let i = 0; i < points.length; i++) {
		const [x1, z1] = points[i] as Point;
		const [x2, z2] = points[(i + 1) % points.length] as Point;
		sum += BigInt(x1) * BigInt(z2) - BigInt(x2) * BigInt(z1);
	}
	return sum;
}

const linePath = z
	.array(pointSchema)
	.min(2)
	.max(MAX_VERTICES)
	.refine((g) => distinctPoints(g) >= 2, "a line needs two different points");

/**
 * A line is one path, `[[x, z], ...]`, or several, `[[[x, z], ...], ...]`. A path that ends
 * where it starts is a closed loop, and paths that share a block are joined there, which is how
 * a line branches.
 */
const lineGeometry = z.union([
	linePath,
	z
		.array(linePath)
		.min(1)
		.refine(
			(paths) => paths.reduce((n, p) => n + p.length, 0) <= MAX_VERTICES,
			`a line can have at most ${MAX_VERTICES} points`,
		),
]);
export type LineGeometry = z.infer<typeof lineGeometry>;

/** The paths of a line, whichever of the two forms it is stored in. */
export function linePaths(geometry: LineGeometry): Point[][] {
	const [first] = geometry;
	return first !== undefined && Array.isArray(first[0])
		? (geometry as Point[][])
		: [geometry as Point[]];
}
const polygonGeometry = z
	.array(pointSchema)
	.min(3)
	.max(MAX_VERTICES)
	.refine((g) => distinctPoints(g) >= 3, "an area needs three different points")
	.refine((g) => doubleArea(g) !== 0n, "an area cannot be flat");

const common = {
	name: z.string().trim().max(MAX_NAME),
	popup: z.string().max(MAX_POPUP).default(""),
	color: dyeSchema.nullable().default(null),
};

export const featureInputSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pin"), geometry: pointSchema, ...common }),
	z.object({ type: z.literal("line"), geometry: lineGeometry, ...common }),
	z.object({
		type: z.literal("polygon"),
		geometry: polygonGeometry,
		...common,
	}),
]);
export type FeatureInput = z.infer<typeof featureInputSchema>;
export type FeatureType = FeatureInput["type"];

/** Partial update; the merged result is validated with featureInputSchema. */
export const featurePatchSchema = z.object({
	/** The revision the edit is based on; if the feature has moved on since, the update answers 409. */
	baseRevisionId: z.number().int().positive().optional(),
	type: z.enum(FEATURE_TYPES).optional(),
	name: z.string().optional(),
	popup: z.string().optional(),
	color: dyeSchema.nullable().optional(),
	geometry: z.unknown().optional(),
});

export const featureImportSchema = z
	.array(featureInputSchema)
	.max(MAX_FEATURES_PER_LAYER);

/** New order of the layers of a dimension, or of the features of a layer, as ids. */
export const reorderSchema = z.object({
	ids: z.array(z.number().int().positive()).max(10_000),
});
export const reorderLayersSchema = reorderSchema.extend({
	dimension: z.string().min(1),
});

export const featureHistoryQuerySchema = z.object({
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_HISTORY_LIMIT)
		.default(DEFAULT_HISTORY_LIMIT),
	/** Only revisions older than this revision id. */
	before: z.coerce.number().int().positive().optional(),
});

export const layerVisibilitySchema = z.enum(["public", "private"]);

export const createLayerSchema = z.object({
	dimension: z.string().min(1),
	name: z.string().trim().min(1).max(MAX_NAME),
	color: dyeSchema.default("white"),
	hiddenByDefault: z.boolean().default(false),
	visibility: layerVisibilitySchema.default("public"),
});
export type CreateLayer = z.infer<typeof createLayerSchema>;

export const updateLayerSchema = z
	.object({
		name: z.string().trim().min(1).max(MAX_NAME).optional(),
		color: dyeSchema.optional(),
		hiddenByDefault: z.boolean().optional(),
		visibility: layerVisibilitySchema.optional(),
	})
	.refine(nonEmpty, "nothing to update");
export type UpdateLayer = z.infer<typeof updateLayerSchema>;

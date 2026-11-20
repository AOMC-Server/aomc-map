import * as z from "zod/mini";
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

const linePath = z.array(pointSchema).check(
	z.minLength(2),
	z.maxLength(MAX_VERTICES),
	z.refine((g) => distinctPoints(g) >= 2, "a line needs two different points"),
);

/**
 * A line is one path, `[[x, z], ...]`, or several, `[[[x, z], ...], ...]`. A path that ends
 * where it starts is a closed loop, and paths that share a block are joined there, which is how
 * a line branches.
 */
const lineGeometry = z.union([
	linePath,
	z.array(linePath).check(
		z.minLength(1),
		z.refine(
			(paths) => paths.reduce((n, p) => n + p.length, 0) <= MAX_VERTICES,
			`a line can have at most ${MAX_VERTICES} points`,
		),
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
const polygonGeometry = z.array(pointSchema).check(
	z.minLength(3),
	z.maxLength(MAX_VERTICES),
	z.refine(
		(g) => distinctPoints(g) >= 3,
		"an area needs three different points",
	),
	z.refine((g) => doubleArea(g) !== 0n, "an area cannot be flat"),
);

export const LINE_DASHES = ["solid", "dashed", "dotted"] as const;
export const AREA_FILLS = [
	"none",
	"solid",
	"stripes",
	"crosshatch",
	"dots",
] as const;
export const MIN_LINE_WIDTH = 1;
export const MAX_LINE_WIDTH = 10;
export const DEFAULT_LINE_WIDTH = 3;
export const DEFAULT_AREA_LINE_WIDTH = 2;
export const DEFAULT_FILL_OPACITY = 0.2;

/**
 * How a line or an area is drawn; what is left out is the default (a solid line of 3 pixels, or
 * 2 for the outline of an area, fully opaque, with a solid fill of 20% opacity, not smoothed).
 * `width` is in screen pixels. `dash`, `width`, `opacity` and `smooth` are about the line (or an
 * area's outline), `fill` and `fillOpacity` about an area's inside.
 */
export const styleSchema = z.strictObject({
	dash: z.optional(z.enum(LINE_DASHES)),
	width: z.optional(
		z.int().check(z.minimum(MIN_LINE_WIDTH), z.maximum(MAX_LINE_WIDTH)),
	),
	opacity: z.optional(z.number().check(z.minimum(0.1), z.maximum(1))),
	fill: z.optional(z.enum(AREA_FILLS)),
	fillOpacity: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
	/** Draw the line (or outline) as a curve through its points; forks stay sharp corners. */
	smooth: z.optional(z.boolean()),
});
export type FeatureStyle = z.infer<typeof styleSchema>;

/** The style without the fields that are not set, or null when none is. */
export function cleanStyle(
	style: FeatureStyle | null | undefined,
): FeatureStyle | null {
	if (!style) return null;
	const out = Object.fromEntries(
		Object.entries(style).filter(([, v]) => v !== undefined),
	) as FeatureStyle;
	return Object.keys(out).length > 0 ? out : null;
}

/** A style with the fields of `over` laid over those of `base`. */
export function mergeStyle(
	base: FeatureStyle | null | undefined,
	over: FeatureStyle | null | undefined,
): FeatureStyle {
	return { ...cleanStyle(base), ...cleanStyle(over) };
}

const common = {
	name: z.string().check(z.trim(), z.maxLength(MAX_NAME)),
	popup: z._default(z.string().check(z.maxLength(MAX_POPUP)), ""),
	color: z._default(z.nullable(dyeSchema), null),
};

export const featureInputSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pin"), geometry: pointSchema, ...common }),
	z.object({
		type: z.literal("line"),
		geometry: lineGeometry,
		style: z._default(z.nullable(styleSchema), null),
		...common,
	}),
	z.object({
		type: z.literal("polygon"),
		geometry: polygonGeometry,
		style: z._default(z.nullable(styleSchema), null),
		...common,
	}),
]);
export type FeatureInput = z.infer<typeof featureInputSchema>;
export type FeatureType = FeatureInput["type"];

/** Partial update; the merged result is validated with featureInputSchema. */
export const featurePatchSchema = z.object({
	/** The revision the edit is based on; if the feature has moved on since, the update answers 409. */
	baseRevisionId: z.optional(z.int().check(z.positive())),
	type: z.optional(z.enum(FEATURE_TYPES)),
	name: z.optional(z.string()),
	popup: z.optional(z.string()),
	color: z.optional(z.nullable(dyeSchema)),
	style: z.optional(z.nullable(styleSchema)),
	geometry: z.optional(z.unknown()),
	/** Moves the feature to another layer of the same dimension. */
	layerId: z.optional(z.int().check(z.positive())),
});

export const featureImportSchema = z
	.array(featureInputSchema)
	.check(z.maxLength(MAX_FEATURES_PER_LAYER));

/** New order of the layers of a dimension, or of the features of a layer, as ids. */
export const reorderSchema = z.object({
	ids: z.array(z.int().check(z.positive())).check(z.maxLength(10_000)),
});
export const reorderLayersSchema = z.extend(reorderSchema, {
	dimension: z.string().check(z.minLength(1)),
});

export const featureHistoryQuerySchema = z.object({
	limit: z._default(
		z.pipe(
			z.coerce.number(),
			z.int().check(z.minimum(1), z.maximum(MAX_HISTORY_LIMIT)),
		),
		DEFAULT_HISTORY_LIMIT,
	),
	/** Only revisions older than this revision id. */
	before: z.optional(z.pipe(z.coerce.number(), z.int().check(z.positive()))),
});

export const layerVisibilitySchema = z.enum(["public", "private"]);

const layerName = z
	.string()
	.check(z.trim(), z.minLength(1), z.maxLength(MAX_NAME));

export const createLayerSchema = z.object({
	dimension: z.string().check(z.minLength(1)),
	name: layerName,
	color: z._default(dyeSchema, "white"),
	hiddenByDefault: z._default(z.boolean(), false),
	visibility: z._default(layerVisibilitySchema, "public"),
	/** How the lines and areas of the layer are drawn unless they say otherwise. */
	style: z._default(z.nullable(styleSchema), null),
});
export type CreateLayer = z.infer<typeof createLayerSchema>;

export const updateLayerSchema = z
	.object({
		name: z.optional(layerName),
		color: z.optional(dyeSchema),
		hiddenByDefault: z.optional(z.boolean()),
		visibility: z.optional(layerVisibilitySchema),
		style: z.optional(z.nullable(styleSchema)),
	})
	.check(z.refine(nonEmpty, "nothing to update"));
export type UpdateLayer = z.infer<typeof updateLayerSchema>;

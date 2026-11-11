import { z } from "zod";
import { DYES } from "./colors";
import { MAX_COORD } from "./schemas";

export const MAX_NAME = 100;
export const MAX_POPUP = 2000;
export const MAX_VERTICES = 2000;
export const MAX_FEATURES_PER_LAYER = 5000;

export const dyeSchema = z.enum(DYES);

const blockCoord = z.number().int().min(-MAX_COORD).max(MAX_COORD);
/** [x, z] in block coordinates. */
export const pointSchema = z.tuple([blockCoord, blockCoord]);
export type Point = z.infer<typeof pointSchema>;

const common = {
	name: z.string().trim().max(MAX_NAME),
	popup: z.string().max(MAX_POPUP).default(""),
	color: dyeSchema.nullable().default(null),
};

export const featureInputSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pin"), geometry: pointSchema, ...common }),
	z.object({
		type: z.literal("line"),
		geometry: z.array(pointSchema).min(2).max(MAX_VERTICES),
		...common,
	}),
	z.object({
		type: z.literal("polygon"),
		geometry: z.array(pointSchema).min(3).max(MAX_VERTICES),
		...common,
	}),
]);
export type FeatureInput = z.infer<typeof featureInputSchema>;
export type FeatureType = FeatureInput["type"];

/** Partial update; the merged result is validated with featureInputSchema. */
export const featurePatchSchema = z.object({
	type: z.enum(["pin", "line", "polygon"]).optional(),
	name: z.string().optional(),
	popup: z.string().optional(),
	color: dyeSchema.nullable().optional(),
	geometry: z.unknown().optional(),
});

export const featureImportSchema = z
	.array(featureInputSchema)
	.max(MAX_FEATURES_PER_LAYER);

export const layerVisibilitySchema = z.enum(["inherit", "private"]);

export const createLayerSchema = z.object({
	dimension: z.string().min(1),
	name: z.string().trim().min(1).max(MAX_NAME),
	color: dyeSchema.default("white"),
	hiddenByDefault: z.boolean().default(false),
	visibility: layerVisibilitySchema.default("inherit"),
});
export type CreateLayer = z.infer<typeof createLayerSchema>;

export const updateLayerSchema = z.object({
	name: z.string().trim().min(1).max(MAX_NAME).optional(),
	color: dyeSchema.optional(),
	hiddenByDefault: z.boolean().optional(),
	sortOrder: z.number().int().optional(),
	visibility: layerVisibilitySchema.optional(),
});
export type UpdateLayer = z.infer<typeof updateLayerSchema>;

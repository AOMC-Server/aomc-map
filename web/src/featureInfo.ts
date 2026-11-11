import type { FeatureType, Point } from "@aomc/shared/features";

export const TYPE_LABEL: Record<FeatureType, string> = {
	pin: "Pin",
	line: "Line",
	polygon: "Area",
};

export const featureTitle = (f: { name: string; type: FeatureType }) =>
	f.name || TYPE_LABEL[f.type];

/** The vertices of a feature; a pin has exactly one. */
export const pointsOf = (f: {
	type: FeatureType;
	geometry: unknown;
}): Point[] =>
	f.type === "pin" ? [f.geometry as Point] : (f.geometry as Point[]);

export const dyeLabel = (dye: string) => dye.replace("_", " ");

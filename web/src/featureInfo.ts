import {
	type FeatureType,
	type LineGeometry,
	linePaths,
	type Point,
} from "@aomc/shared/features";

export const TYPE_LABEL: Record<FeatureType, string> = {
	pin: "Pin",
	line: "Line",
	polygon: "Area",
};

export const featureTitle = (f: { name: string; type: FeatureType }) =>
	f.name || TYPE_LABEL[f.type];

/** The paths of a feature: one for a pin (of one point) or an area, one or more for a line. */
export function pathsOf(f: {
	type: FeatureType;
	geometry: unknown;
}): Point[][] {
	if (f.type === "pin") return [[f.geometry as Point]];
	if (f.type === "line") return linePaths(f.geometry as LineGeometry);
	return [f.geometry as Point[]];
}

/** The vertices of a feature; a pin has exactly one. Where a line's paths meet, the point is listed for each. */
export const pointsOf = (f: {
	type: FeatureType;
	geometry: unknown;
}): Point[] => pathsOf(f).flat();

export const dyeLabel = (dye: string) => dye.replace("_", " ");

import {
	type FeatureType,
	type LineGeometry,
	linePaths,
	type Point,
} from "@aomc/shared/features";

import { polylineArea, polylineLength, smoothShape } from "./map/smooth";
import { graphFromPaths, lineLength } from "./tools/lineGraph";
import { pathLength, polygonArea } from "./tools/measureMath";

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

export type FeatureStats = {
	/** A line: the length of all of it, branches included. */
	length?: number;
	/** An area: the length of its outline. */
	perimeter?: number;
	/** An area: what it encloses, in square blocks. */
	area?: number;
};

const statsCache = new WeakMap<
	object,
	{ straight?: FeatureStats; smooth?: FeatureStats }
>();

/**
 * Length of a line, or perimeter and area of an area; nothing for a pin. `smooth`: measured
 * along the curve the feature is drawn as. Cached per feature.
 */
export function featureStats(
	f: { type: FeatureType; geometry: unknown },
	smooth = false,
): FeatureStats {
	const key = smooth ? "smooth" : "straight";
	const cached = statsCache.get(f)?.[key];
	if (cached) return cached;
	let out: FeatureStats = {};
	if (f.type === "line") {
		out = {
			length: smooth
				? smoothShape("line", pathsOf(f)).strokes.reduce(
						(sum, s) => sum + polylineLength(s.samples),
						0,
					)
				: lineLength(graphFromPaths(pathsOf(f))),
		};
	} else if (f.type === "polygon") {
		if (smooth) {
			const samples =
				smoothShape("polygon", pathsOf(f)).strokes[0]?.samples ?? [];
			out = {
				perimeter: polylineLength(samples),
				area: polylineArea(samples),
			};
		} else {
			const points = (f.geometry as Point[]).map(([x, z]) => ({ x, z }));
			out = {
				perimeter: pathLength(points, true),
				area: polygonArea(points),
			};
		}
	}
	statsCache.set(f, { ...statsCache.get(f), [key]: out });
	return out;
}

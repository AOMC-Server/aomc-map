import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DYE_HEX,
	DYES,
	type Dye,
	type FeatureStyle,
	type Point,
} from "@aomc/shared";
import { dashPattern, resolveStyle } from "@aomc/shared/featureStyle";
import { linePaths } from "@aomc/shared/features";
import {
	fillPatternMarkup,
	PATTERN_SIZE,
	type PatternFill,
} from "@aomc/shared/fillPattern";
import { blockToScreen, type Size, type View } from "@aomc/shared/view";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { layers } from "./db/schema";
import { type FeatureView, featuresOfLayers, layerLiveAt } from "./features";

/** Most lines and areas, and most pins, drawn in one picture. */
const MAX_SHAPES = 1500;
const MAX_PINS = 400;
const MAX_POINTS = 60_000;
const ICON_W = 24;
const ICON_H = 24;
/** Shapes are cut off this far outside the picture, which keeps the numbers small. */
const CLIP_MARGIN = 64;
const BLOCK_CENTER = 0.5;

export type OverlayLayer = {
	color: string;
	style: FeatureStyle | null;
	features: Pick<FeatureView, "id" | "type" | "color" | "style" | "geometry">[];
};

type Pt = [number, number];

const dyeOf = (name: string | null | undefined, fallback: string): Dye => {
	const wanted = (name ?? fallback) as Dye;
	return wanted in DYE_HEX ? wanted : "red";
};

/**
 * The public layers of a dimension that a preview shows, with their features as of `at` (unix
 * ms, null for now). `wanted` lists layer ids; without it each layer's default decides.
 */
export function loadOverlayLayers(
	db: Db,
	dimensionId: number,
	at: number | null,
	wanted: number[] | null,
): OverlayLayer[] {
	const rows = db
		.select()
		.from(layers)
		.where(
			and(
				eq(layers.dimensionId, dimensionId),
				eq(layers.visibility, "public"),
				layerLiveAt(at),
			),
		)
		.orderBy(layers.sortOrder, layers.id)
		.all()
		.filter((l) => (wanted ? wanted.includes(l.id) : !l.hiddenByDefault));
	if (rows.length === 0) return [];
	const byLayer = featuresOfLayers(
		db,
		rows.map((l) => l.id),
		at,
	);
	return rows.map((l) => ({
		color: l.color,
		style: l.style,
		features: byLayer.get(l.id) ?? [],
	}));
}

const f = (n: number) => String(Math.round(n * 10) / 10);

/** The parts of a polyline inside the rectangle (Liang-Barsky), as separate polylines. */
function clipLine(points: Pt[], r: [number, number, number, number]): Pt[][] {
	const [minX, minY, maxX, maxY] = r;
	const out: Pt[][] = [];
	let current: Pt[] = [];
	for (let i = 1; i < points.length; i++) {
		const [x0, y0] = points[i - 1] as Pt;
		const [x1, y1] = points[i] as Pt;
		const dx = x1 - x0;
		const dy = y1 - y0;
		let t0 = 0;
		let t1 = 1;
		let inside = true;
		for (const [p, q] of [
			[-dx, x0 - minX],
			[dx, maxX - x0],
			[-dy, y0 - minY],
			[dy, maxY - y0],
		] as const) {
			if (p === 0) {
				if (q < 0) inside = false;
			} else {
				const t = q / p;
				if (p < 0) t0 = Math.max(t0, t);
				else t1 = Math.min(t1, t);
			}
		}
		if (!inside || t0 > t1) {
			if (current.length > 1) out.push(current);
			current = [];
			continue;
		}
		const a: Pt = [x0 + t0 * dx, y0 + t0 * dy];
		const b: Pt = [x0 + t1 * dx, y0 + t1 * dy];
		if (current.length === 0 || t0 > 0) {
			if (current.length > 1) out.push(current);
			current = [a];
		}
		current.push(b);
		if (t1 < 1) {
			out.push(current);
			current = [];
		}
	}
	if (current.length > 1) out.push(current);
	return out;
}

/** A polygon cut to the rectangle (Sutherland-Hodgman). */
function clipPolygon(points: Pt[], r: [number, number, number, number]): Pt[] {
	const [minX, minY, maxX, maxY] = r;
	const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
		[
			(p) => p[0] >= minX,
			(a, b) => [minX, a[1] + ((b[1] - a[1]) * (minX - a[0])) / (b[0] - a[0])],
		],
		[
			(p) => p[0] <= maxX,
			(a, b) => [maxX, a[1] + ((b[1] - a[1]) * (maxX - a[0])) / (b[0] - a[0])],
		],
		[
			(p) => p[1] >= minY,
			(a, b) => [a[0] + ((b[0] - a[0]) * (minY - a[1])) / (b[1] - a[1]), minY],
		],
		[
			(p) => p[1] <= maxY,
			(a, b) => [a[0] + ((b[0] - a[0]) * (maxY - a[1])) / (b[1] - a[1]), maxY],
		],
	];
	let poly = points;
	for (const [inside, cross] of edges) {
		const next: Pt[] = [];
		for (let i = 0; i < poly.length; i++) {
			const a = poly[i] as Pt;
			const b = poly[(i + 1) % poly.length] as Pt;
			if (inside(b)) {
				if (!inside(a)) next.push(cross(a, b));
				next.push(b);
			} else if (inside(a)) next.push(cross(a, b));
		}
		poly = next;
		if (poly.length === 0) break;
	}
	return poly;
}

const knot = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5;

/** A centripetal Catmull-Rom curve through the points, as short straight pieces. */
function smoothen(points: Pt[], closed: boolean): Pt[] {
	const pts = points.filter(
		(p, i) =>
			i === 0 ||
			p[0] !== (points[i - 1] as Pt)[0] ||
			p[1] !== (points[i - 1] as Pt)[1],
	);
	if (closed && pts.length > 1) {
		const a = pts[0] as Pt;
		const b = pts[pts.length - 1] as Pt;
		if (a[0] === b[0] && a[1] === b[1]) pts.pop();
	}
	const n = pts.length;
	if (n < 3) return points;
	const at = (i: number): Pt =>
		closed
			? (pts[((i % n) + n) % n] as Pt)
			: i < 0
				? [
						2 * (pts[0] as Pt)[0] - (pts[1] as Pt)[0],
						2 * (pts[0] as Pt)[1] - (pts[1] as Pt)[1],
					]
				: i >= n
					? [
							2 * (pts[n - 1] as Pt)[0] - (pts[n - 2] as Pt)[0],
							2 * (pts[n - 1] as Pt)[1] - (pts[n - 2] as Pt)[1],
						]
					: (pts[i] as Pt);
	const out: Pt[] = [pts[0] as Pt];
	const segments = closed ? n : n - 1;
	for (let i = 0; i < segments; i++) {
		const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
		const t0 = 0;
		const t1 = t0 + knot(p0, p1);
		const t2 = t1 + knot(p1, p2);
		const t3 = t2 + knot(p2, p3);
		const steps = Math.min(
			32,
			Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 6)),
		);
		const mix = (a: Pt, b: Pt, ta: number, tb: number, t: number): Pt =>
			tb === ta
				? a
				: [
						((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0],
						((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1],
					];
		for (let s = 1; s <= steps; s++) {
			const t = t1 + ((t2 - t1) * s) / steps;
			const a1 = mix(p0, p1, t0, t1, t);
			const a2 = mix(p1, p2, t1, t2, t);
			const a3 = mix(p2, p3, t2, t3, t);
			out.push(mix(mix(a1, a2, t0, t2, t), mix(a2, a3, t1, t3, t), t1, t3, t));
		}
	}
	return out;
}

const pathData = (pieces: Pt[][], close: boolean) =>
	pieces
		.map(
			(pts) =>
				`M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}${close ? "Z" : ""}`,
		)
		.join("");

function patternDef(fill: PatternFill, hex: string) {
	const s = PATTERN_SIZE;
	return `<pattern id="${fill}-${hex.slice(1)}" width="${s}" height="${s}" patternUnits="userSpaceOnUse">${fillPatternMarkup(fill, hex)}</pattern>`;
}

/**
 * An SVG of the lines, areas and pins of the layers, drawn like the map draws them, or null when
 * there is nothing to show. `icon` gives a pin's picture as a data URI; without one a dot is drawn.
 * Pin clusters are not made: every pin is drawn, the first MAX_PINS of them.
 */
export function buildOverlay(
	layersToDraw: OverlayLayer[],
	view: View,
	size: Size,
	icon: (dye: Dye) => string | undefined = () => undefined,
): string | null {
	const project = (x: number, z: number): Pt => {
		const s = blockToScreen(view, size, x + BLOCK_CENTER, z + BLOCK_CENTER);
		return [s.x, s.y];
	};
	const clip: [number, number, number, number] = [
		-CLIP_MARGIN,
		-CLIP_MARGIN,
		size.width + CLIP_MARGIN,
		size.height + CLIP_MARGIN,
	];
	const onScreen = (pts: Pt[]) => {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const [x, y] of pts) {
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
		return (
			maxX >= clip[0] && minX <= clip[2] && maxY >= clip[1] && minY <= clip[3]
		);
	};

	const defs = new Set<string>();
	const areas: string[] = [];
	const lines: string[] = [];
	const pins: string[] = [];
	let shapes = 0;
	let points = 0;

	for (const layer of layersToDraw) {
		for (const feature of layer.features) {
			const hex = DYE_HEX[dyeOf(feature.color, layer.color)];
			if (feature.type === "pin") {
				if (pins.length >= MAX_PINS) continue;
				const [x, z] = feature.geometry as Point;
				const [sx, sy] = project(x, z);
				if (
					sx < -ICON_W ||
					sx > size.width + ICON_W ||
					sy < 0 ||
					sy > size.height + ICON_H
				)
					continue;
				const uri = icon(dyeOf(feature.color, layer.color));
				pins.push(
					uri
						? `<image href="${uri}" image-rendering="optimizeSpeed" style="image-rendering:pixelated" x="${f(sx - ICON_W / 2)}" y="${f(sy - ICON_H)}" width="${ICON_W}" height="${ICON_H}"/>`
						: `<circle cx="${f(sx)}" cy="${f(sy - ICON_H / 2)}" r="6" fill="${hex}" stroke="#000" stroke-opacity="0.55"/>`,
				);
				continue;
			}
			if (shapes >= MAX_SHAPES || points >= MAX_POINTS) continue;

			const closed = feature.type === "polygon";
			const style = resolveStyle(feature.style, closed, layer.style);
			const paths: Pt[][] = (
				closed
					? [feature.geometry as Point[]]
					: linePaths(feature.geometry as Point[])
			).map((path) => path.map(([x, z]) => project(x, z)));
			if (!paths.some(onScreen)) continue;

			let pieces: Pt[][] = [];
			for (const path of paths) {
				const curve = style.smooth ? smoothen(path, closed) : path;
				if (closed) {
					const cut = clipPolygon(curve, clip);
					if (cut.length >= 3) pieces.push(cut);
				} else {
					const loop =
						(path[0] as Pt)[0] === (path[path.length - 1] as Pt)[0] &&
						(path[0] as Pt)[1] === (path[path.length - 1] as Pt)[1];
					pieces.push(
						...clipLine(
							style.smooth && loop
								? smoothen(path, true).concat([path[0] as Pt])
								: curve,
							clip,
						),
					);
				}
			}
			pieces = pieces.filter((p) => p.length > 1);
			if (pieces.length === 0) continue;
			shapes++;
			points += pieces.reduce((n, p) => n + p.length, 0);

			const d = pathData(pieces, closed);
			const dash = dashPattern(style.dash, style.width);
			const stroke = (color: string, width: number, opacity: number) =>
				`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${f(opacity)}" stroke-linecap="round" stroke-linejoin="round"${
					dash.length ? ` stroke-dasharray="${dash.join(" ")}"` : ""
				}/>`;
			const body =
				stroke("#000", style.width + 2, 0.55 * style.opacity) +
				stroke(hex, style.width, style.opacity);
			if (closed) {
				let paint: string = hex;
				if (
					style.fill === "stripes" ||
					style.fill === "crosshatch" ||
					style.fill === "dots"
				) {
					defs.add(patternDef(style.fill, hex));
					paint = `url(#${style.fill}-${hex.slice(1)})`;
				}
				areas.push(
					(style.fill !== "none"
						? `<path d="${d}" fill="${paint}" fill-opacity="${f(style.fillOpacity)}" stroke="none"/>`
						: "") + body,
				);
			} else lines.push(body);
		}
	}
	if (areas.length + lines.length + pins.length === 0) return null;
	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><defs>${[...defs].join("")}</defs>${areas.join("")}${lines.join("")}${pins.join("")}</svg>`;
}

const iconCache = new Map<string, Promise<Map<Dye, string>>>();

/** The banner icons the pins use, as data URIs, read once from the first of `dirs` that has them. */
export function loadIcons(dirs: string[]): Promise<Map<Dye, string>> {
	const key = dirs.join("\0");
	let cached = iconCache.get(key);
	if (!cached) {
		cached = (async () => {
			const icons = new Map<Dye, string>();
			for (const dir of dirs) {
				for (const dye of DYES) {
					if (icons.has(dye)) continue;
					try {
						const png = await readFile(join(dir, `${dye}_banner.png`));
						icons.set(dye, `data:image/png;base64,${png.toString("base64")}`);
					} catch {}
				}
			}
			return icons;
		})();
		iconCache.set(key, cached);
	}
	return cached;
}

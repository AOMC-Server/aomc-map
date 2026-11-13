import { DYE_HEX, type Dye } from "@aomc/shared/colors";
import type { FeatureStyle } from "@aomc/shared/features";
import {
	blockToScreen,
	type Size,
	scaleOf,
	screenToBlock,
	type View,
} from "@aomc/shared/view";
import { pathsOf } from "../featureInfo";
import { ClusterIndex, type ClusterNode } from "./cluster";
import {
	dashPattern,
	emphasisedWidth,
	hitTolerance,
	type ResolvedStyle,
	resolveStyle,
} from "./featureStyle";
import {
	type Bounds,
	boundsOf,
	distToPolyline,
	intersects,
	type Pt,
	pointInPolygon,
} from "./geometry";
import { type SmoothShape, smoothShape } from "./smooth";
import { viewportBlocks } from "./viewport";

type RenderFeature = {
	id: number;
	layerId: number;
	type: "pin" | "line" | "polygon";
	name: string;
	popup: string;
	color: Dye | null;
	/** How a line or an area is drawn; null or missing: the defaults. */
	style?: FeatureStyle | null;
	/** pin: [x, z]; line / polygon: [[x, z], ...]; a line can also be [[[x, z], ...], ...] */
	geometry: unknown;
};

export type RenderLayer = {
	id: number;
	color: Dye;
	/** The default style of the layer's lines and areas. */
	style?: FeatureStyle | null;
	features: RenderFeature[];
};

export type Hit =
	| { kind: "feature"; feature: RenderFeature; layer: RenderLayer }
	| { kind: "cluster"; count: number; bounds: Bounds };

/** Features are drawn at the centre of their block. */
export const BLOCK_CENTER = 0.5;

/** A cluster grows a little with the number of pins in it. */
const clusterRadius = (count: number) => 13 + Math.min(8, Math.log2(count) * 2);

const ICON_W = 24;
const ICON_H = 24;
/** Pins closer than this on screen (just after switching to a level; about half at its end) merge. */
export const CLUSTER_RADIUS_PX = 56;
/**
 * Cluster levels switch at zooms of k + 0.25, and the crossfade covers this much zoom around
 * each switch. The grid that wheel zooming snaps to (multiples of 0.5) stays clear of it, so a
 * view that has come to rest never shows half-faded clusters.
 */
const SWITCH_OFFSET = 0.25;
const FADE_WIDTH = 0.44;
/** The lowest zoom level that clusters. Closer than that, pins are always shown one by one. */
export const MIN_CLUSTER_LEVEL = -2;
const MAX_CLUSTER_LEVEL = 24;
/** Side of a tile of the patterns that fill areas, in css pixels. */
const PATTERN_SIZE = 8;

type Prepared = {
	feature: RenderFeature;
	layer: RenderLayer;
	bounds: Bounds;
	points: Pt[];
	/** A pin's one point, an area's outline, or the paths of a line. */
	paths: Pt[][];
	/** The curves of a smoothed line or area; null when it is drawn straight. */
	smooth: SmoothShape | null;
	/** What is hit-tested: the paths of a line, or an area's outline, as the curve goes when smoothed. */
	strokes: (readonly Pt[])[];
};
type DrawnPin = { x: number; y: number; item: Prepared };
type PinNode = ClusterNode<Prepared>;
type DrawnCluster = {
	x: number;
	y: number;
	r: number;
	count: number;
	bounds: Bounds;
};

function hexToRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function prepare(feature: RenderFeature, layer: RenderLayer): Prepared {
	const paths = pathsOf(feature);
	const points = paths.flat();
	const smooth =
		feature.type !== "pin" &&
		resolveStyle(feature.style, feature.type === "polygon", layer.style).smooth
			? smoothShape(feature.type, paths)
			: null;
	return {
		feature,
		layer,
		points,
		paths,
		smooth,
		strokes: smooth ? smooth.strokes.map((s) => s.samples) : paths,
		bounds: smooth ? smooth.bounds : boundsOf(points),
	};
}

/** Draws pins (clustered by the world-fixed `ClusterIndex`), lines and polygons, and answers hit-test queries. */
export class FeatureLayer {
	private prepared: Prepared[] = [];
	private clusterPx = CLUSTER_RADIUS_PX;
	private clusters = new ClusterIndex<Prepared>([], {
		radiusPx: CLUSTER_RADIUS_PX,
		minLevel: MIN_CLUSTER_LEVEL,
		maxLevel: MAX_CLUSTER_LEVEL,
	});
	private icons = new Map<Dye, HTMLImageElement>();
	private drawnPins: DrawnPin[] = [];
	private drawnClusters: DrawnCluster[] = [];
	private selectedShown = false;
	/** The feature being edited, drawn in its new shape and style in place of the saved one. */
	private draft: { replaces: number | null; item: Prepared } | null = null;
	/** What is drawn and hit: the prepared features with the draft in the place of the one it replaces. */
	private shown: Prepared[] = [];
	private patterns = new Map<string, CanvasPattern | null>();
	/** Where block (0, 0) is on screen, which the fill patterns are anchored to so they move with the map. */
	private origin = { x: 0, y: 0 };
	hoveredId: number | null = null;
	selectedId: number | null = null;

	constructor(private onChange: () => void) {}

	setFeatures(layers: RenderLayer[]) {
		this.prepared = layers.flatMap((layer) =>
			layer.features.map((feature) => prepare(feature, layer)),
		);
		this.rebuildClusters();
		this.refreshShown();
		this.onChange();
	}

	/** How far apart (in px) pins may be and still clump together. */
	setClusterDistance(px: number) {
		if (px === this.clusterPx) return;
		this.clusterPx = px;
		this.rebuildClusters();
		this.onChange();
	}

	private rebuildClusters() {
		this.clusters = new ClusterIndex(
			this.prepared
				.filter((p) => p.feature.type === "pin")
				.map((p) => {
					const [x, z] = p.points[0] as Pt;
					return { x, z, item: p, rgb: hexToRgb(DYE_HEX[this.colorOf(p)]) };
				}),
			{
				radiusPx: this.clusterPx,
				minLevel: MIN_CLUSTER_LEVEL,
				maxLevel: MAX_CLUSTER_LEVEL,
			},
		);
		this.drawnPins = [];
		this.drawnClusters = [];
	}

	/**
	 * Shows `feature` (a line or an area) in place of the saved feature `replaces`, or as an extra
	 * one when it is null, until called with null. Used to preview what the editor is changing.
	 */
	setDraft(
		layer: { id: number; color: Dye; style?: FeatureStyle | null },
		feature: RenderFeature | null,
		replaces: number | null,
	) {
		if (!feature) {
			if (!this.draft) return;
			this.draft = null;
		} else {
			this.draft = {
				replaces,
				item: prepare(feature, { ...layer, features: [] }),
			};
		}
		this.refreshShown();
		this.onChange();
	}

	private refreshShown() {
		const d = this.draft;
		if (!d) {
			this.shown = this.prepared;
			return;
		}
		const out = this.prepared.map((p) =>
			p.feature.id === d.replaces ? d.item : p,
		);
		if (
			d.replaces === null ||
			!this.prepared.some((p) => p.feature.id === d.replaces)
		)
			out.push(d.item);
		this.shown = out;
	}

	private icon(color: Dye): HTMLImageElement {
		let img = this.icons.get(color);
		if (!img) {
			img = new Image();
			img.onload = () => this.onChange();
			img.src = `/static/markers/${color}_banner.png`;
			this.icons.set(color, img);
		}
		return img;
	}

	private colorOf(p: Prepared): Dye {
		return p.feature.color ?? p.layer.color;
	}

	draw(ctx: CanvasRenderingContext2D, view: View, size: Size) {
		this.drawnPins = [];
		this.drawnClusters = [];
		if (this.shown.length === 0) return;

		const viewport = viewportBlocks(view, size, 40 / scaleOf(view.zoom));
		const project = (x: number, z: number) =>
			blockToScreen(view, size, x + BLOCK_CENTER, z + BLOCK_CENTER);
		this.origin = project(0, 0);

		ctx.save();
		ctx.lineJoin = "round";
		ctx.lineCap = "round";

		for (const p of this.shown) {
			if (!intersects(p.bounds, viewport)) continue;
			if (p.feature.type === "polygon") this.drawShape(ctx, p, project, true);
		}
		for (const p of this.shown) {
			if (p.feature.type === "line" && intersects(p.bounds, viewport)) {
				this.drawShape(ctx, p, project, false);
			}
		}
		// Clusters are fixed per integer level. Around each switch between two levels they are
		// crossfaded, so that zooming (which is smooth) never makes pins pop.
		const p = view.zoom - SWITCH_OFFSET;
		const switchAt = Math.round(p);
		const t = Math.min(Math.max((p - switchAt) / FADE_WIDTH + 0.5, 0), 1);
		const fineLevel = switchAt - 1;
		const inView = (n: PinNode) =>
			n.x >= viewport.minX &&
			n.x <= viewport.maxX &&
			n.z >= viewport.minZ &&
			n.z <= viewport.maxZ;
		this.drawPins(
			ctx,
			this.nodesAt(fineLevel).filter(inView),
			this.nodesAt(fineLevel + 1).filter(inView),
			t,
			project,
		);
		ctx.restore();
	}

	/** Adds the straight paths of a line or area to the current canvas path. */
	private tracePaths(
		ctx: CanvasRenderingContext2D,
		p: Prepared,
		project: (x: number, z: number) => { x: number; y: number },
	) {
		for (const path of p.paths) {
			let lastX = Number.NaN;
			let lastY = Number.NaN;
			path.forEach(([x, z], i) => {
				const s = project(x, z);
				// Skip vertices that fall on the same pixel; huge shapes stay cheap when zoomed out.
				const isEnd = i === path.length - 1;
				if (
					i > 0 &&
					!isEnd &&
					Math.abs(s.x - lastX) + Math.abs(s.y - lastY) < 1.5
				)
					return;
				if (i === 0) ctx.moveTo(s.x, s.y);
				else ctx.lineTo(s.x, s.y);
				lastX = s.x;
				lastY = s.y;
			});
		}
	}

	private drawShape(
		ctx: CanvasRenderingContext2D,
		p: Prepared,
		project: (x: number, z: number) => { x: number; y: number },
		closed: boolean,
	) {
		// The shape being edited keeps its own width: pointing at it must not thicken it.
		const isDraft = this.draft?.item === p;
		const emphasised =
			!isDraft &&
			(p.feature.id === this.hoveredId || p.feature.id === this.selectedId);
		const hex = DYE_HEX[this.colorOf(p)];
		const style = resolveStyle(p.feature.style, closed, p.layer.style);

		ctx.beginPath();
		if (p.smooth) {
			// The curve goes through the same points; projecting its control points is enough.
			for (const stroke of p.smooth.strokes) {
				const start = project(stroke.start[0], stroke.start[1]);
				ctx.moveTo(start.x, start.y);
				for (const [c1, c2, end] of stroke.beziers) {
					const a = project(c1[0], c1[1]);
					const b = project(c2[0], c2[1]);
					const e = project(end[0], end[1]);
					ctx.bezierCurveTo(a.x, a.y, b.x, b.y, e.x, e.y);
				}
				if (stroke.closed) ctx.closePath();
			}
		} else {
			this.tracePaths(ctx, p, project);
		}
		if (closed) {
			ctx.closePath();
			if (style.fill !== "none") {
				ctx.globalAlpha = Math.min(
					1,
					style.fillOpacity + (emphasised ? 0.13 : 0),
				);
				ctx.fillStyle =
					style.fill === "solid"
						? hex
						: (this.pattern(ctx, style.fill, hex) ?? hex);
				ctx.fill();
			}
		}
		const width = emphasised ? emphasisedWidth(style.width) : style.width;
		if (isDraft) {
			// The shape being edited: a solid glow around it, whatever its dash pattern.
			ctx.globalAlpha = 1;
			ctx.strokeStyle = "rgba(255, 232, 102, 0.65)";
			ctx.lineWidth = width + 10;
			ctx.stroke();
		}
		ctx.globalAlpha = style.opacity;
		ctx.setLineDash(dashPattern(style.dash, style.width));
		ctx.strokeStyle = "rgba(0,0,0,0.55)";
		ctx.lineWidth = width + 2;
		ctx.stroke();
		ctx.strokeStyle = hex;
		ctx.lineWidth = width;
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.globalAlpha = 1;
	}

	/** A pattern to fill an area with, in the colour `hex` and anchored to the map. */
	private pattern(
		ctx: CanvasRenderingContext2D,
		fill: Exclude<ResolvedStyle["fill"], "none" | "solid">,
		hex: string,
	): CanvasPattern | null {
		const scale = ctx.getTransform().a || 1;
		const key = `${fill}|${hex}|${scale}`;
		let pattern = this.patterns.get(key);
		if (pattern === undefined) {
			pattern = makePattern(ctx, fill, hex, scale);
			this.patterns.set(key, pattern);
		}
		// Drawn at the size of a pixel of the screen, but moving with the map.
		pattern?.setTransform(
			new DOMMatrix([
				1 / scale,
				0,
				0,
				1 / scale,
				this.origin.x % PATTERN_SIZE,
				this.origin.y % PATTERN_SIZE,
			]),
		);
		return pattern;
	}

	private nodesAt(level: number): PinNode[] {
		return level < MIN_CLUSTER_LEVEL
			? this.clusters.singles()
			: this.clusters.nodes(level);
	}

	/**
	 * `fine` and `coarse` are neighbouring cluster levels; `t` is how far the view has moved from
	 * the fine one (0) to the coarse one (1). A node that is the same in both stays solid.
	 */
	private drawPins(
		ctx: CanvasRenderingContext2D,
		fine: PinNode[],
		coarse: PinNode[],
		t: number,
		project: (x: number, z: number) => { x: number; y: number },
	) {
		const inFine = new Set(fine);
		const inCoarse = new Set(coarse);
		const draw = (
			nodes: PinNode[],
			other: Set<PinNode>,
			weight: number,
			skipShared: boolean,
		) => {
			for (const node of nodes) {
				const shared = other.has(node);
				// A node in both levels is drawn once, by the first pass.
				if (shared && skipShared) continue;
				const alpha = shared ? 1 : weight;
				if (alpha <= 0.01) continue;
				// Hit-testing follows whichever level is stronger right now; shared nodes are solid.
				const active = shared || weight >= 0.5;
				const s = project(node.x, node.z);
				ctx.globalAlpha = alpha;
				if (node.item) {
					if (node.item.feature.id === this.selectedId)
						this.selectedShown = true;
					this.drawPin(ctx, node.item, s.x, s.y, active);
					continue;
				}
				const r = clusterRadius(node.count);
				if (active)
					this.drawnClusters.push({
						x: s.x,
						y: s.y,
						r,
						count: node.count,
						bounds: node.bounds,
					});
				this.drawCluster(ctx, s.x, s.y, r, node.count, node.rgb);
			}
			ctx.globalAlpha = 1;
		};

		this.selectedShown = false;
		// Coarse first so that the fine nodes that stay are drawn on top of it.
		draw(coarse, inFine, t, false);
		draw(fine, inCoarse, 1 - t, true);

		// The pin whose popup or editor is open must not vanish into a cluster.
		if (this.selectedId === null || this.selectedShown) return;
		const selected = this.clusters
			.singles()
			.find((n) => n.item?.feature.id === this.selectedId);
		if (!selected?.item) return;
		const s = project(selected.x, selected.z);
		this.drawPin(ctx, selected.item, s.x, s.y, true);
	}

	private drawPin(
		ctx: CanvasRenderingContext2D,
		item: Prepared,
		x: number,
		y: number,
		hittable: boolean,
	) {
		const emphasised =
			item.feature.id === this.hoveredId || item.feature.id === this.selectedId;
		if (emphasised) {
			ctx.beginPath();
			ctx.arc(x, y - ICON_H / 2, 17, 0, Math.PI * 2);
			ctx.fillStyle = "rgba(255,255,255,0.35)";
			ctx.fill();
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 2;
			ctx.stroke();
		}
		const img = this.icon(this.colorOf(item));
		if (img.complete && img.naturalWidth > 0) {
			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(img, x - ICON_W / 2, y - ICON_H, ICON_W, ICON_H);
		} else {
			ctx.beginPath();
			ctx.arc(x, y - ICON_H / 2, 6, 0, Math.PI * 2);
			ctx.fillStyle = DYE_HEX[this.colorOf(item)];
			ctx.fill();
		}
		if (hittable) this.drawnPins.push({ x, y, item });
	}

	private drawCluster(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		r: number,
		count: number,
		rgb: [number, number, number] | null,
	) {
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = rgb
			? `rgba(${rgb.map(Math.round).join(",")},0.92)`
			: "rgba(88,101,242,0.92)";
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = "#fff";
		ctx.stroke();
		ctx.fillStyle = "#fff";
		ctx.font = "bold 12px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(count > 999 ? "999+" : String(count), x, y + 0.5);
	}

	/** Topmost thing under the pointer: pins and clusters first, then lines, then polygon edges, then polygons. */
	hitTest(view: View, size: Size, sx: number, sy: number): Hit | null {
		for (let i = this.drawnPins.length - 1; i >= 0; i--) {
			const p = this.drawnPins[i] as DrawnPin;
			if (
				Math.abs(sx - p.x) <= ICON_W / 2 + 2 &&
				sy >= p.y - ICON_H - 2 &&
				sy <= p.y + 4
			) {
				return {
					kind: "feature",
					feature: p.item.feature,
					layer: p.item.layer,
				};
			}
		}

		for (let i = this.drawnClusters.length - 1; i >= 0; i--) {
			const c = this.drawnClusters[i] as DrawnCluster;
			if (Math.hypot(sx - c.x, sy - c.y) <= c.r + 2) {
				return { kind: "cluster", count: c.count, bounds: c.bounds };
			}
		}
		const at = screenToBlock(view, size, sx, sy);
		const px = at.x - BLOCK_CENTER;
		const pz = at.z - BLOCK_CENTER;
		const scale = scaleOf(view.zoom);
		const toleranceOf = (p: Prepared) =>
			hitTolerance(
				resolveStyle(
					p.feature.style,
					p.feature.type === "polygon",
					p.layer.style,
				).width,
			) / scale;
		const near = (p: Prepared, tolerance: number) => {
			const b = p.bounds;
			return !(
				px < b.minX - tolerance ||
				px > b.maxX + tolerance ||
				pz < b.minZ - tolerance ||
				pz > b.maxZ + tolerance
			);
		};
		const hit = (p: Prepared): Hit => ({
			kind: "feature",
			feature: p.feature,
			layer: p.layer,
		});
		// Lines are drawn over polygons: lines, then polygon edges, then polygon insides.
		for (let i = this.shown.length - 1; i >= 0; i--) {
			const p = this.shown[i] as Prepared;
			if (p === this.draft?.item || p.feature.type !== "line") continue;
			const tolerance = toleranceOf(p);
			if (
				near(p, tolerance) &&
				p.strokes.some(
					(path) => distToPolyline(px, pz, path, false) <= tolerance,
				)
			)
				return hit(p);
		}
		let inside: Prepared | null = null;
		for (let i = this.shown.length - 1; i >= 0; i--) {
			const p = this.shown[i] as Prepared;
			if (p === this.draft?.item || p.feature.type !== "polygon") continue;
			const tolerance = toleranceOf(p);
			if (!near(p, tolerance)) continue;
			if (distToPolyline(px, pz, p.strokes[0] ?? p.points, true) <= tolerance)
				return hit(p);
			// An area without a fill is only there to be clicked on its edge.
			if (
				!inside &&
				resolveStyle(p.feature.style, true, p.layer.style).fill !== "none" &&
				pointInPolygon(px, pz, p.strokes[0] ?? p.points)
			)
				inside = p;
		}
		return inside ? hit(inside) : null;
	}
}

/** One tile of a fill pattern, drawn at `scale` times its size so that it stays sharp on dense screens. */
function makePattern(
	ctx: CanvasRenderingContext2D,
	fill: "stripes" | "crosshatch" | "dots",
	hex: string,
	scale: number,
): CanvasPattern | null {
	if (typeof document === "undefined") return null;
	const px = Math.max(1, Math.round(PATTERN_SIZE * scale));
	const canvas = document.createElement("canvas");
	canvas.width = px;
	canvas.height = px;
	const g = canvas.getContext("2d");
	if (!g) return null;
	const s = PATTERN_SIZE;
	g.scale(px / s, px / s);
	g.strokeStyle = hex;
	g.fillStyle = hex;
	g.lineWidth = 1.5;
	g.beginPath();
	if (fill === "dots") {
		g.arc(s / 2, s / 2, 1.6, 0, Math.PI * 2);
		g.fill();
	} else {
		// Lines through the corners too, so that the tiles join up.
		g.moveTo(0, s);
		g.lineTo(s, 0);
		g.moveTo(-1, 1);
		g.lineTo(1, -1);
		g.moveTo(s - 1, s + 1);
		g.lineTo(s + 1, s - 1);
		if (fill === "crosshatch") {
			g.moveTo(0, 0);
			g.lineTo(s, s);
			g.moveTo(-1, s - 1);
			g.lineTo(1, s + 1);
			g.moveTo(s - 1, -1);
			g.lineTo(s + 1, 1);
		}
		g.stroke();
	}
	return ctx.createPattern(canvas, "repeat");
}

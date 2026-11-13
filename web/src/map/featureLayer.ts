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
import { DEFAULT_SETTINGS } from "../settings";
import { ClusterIndex, type ClusterNode } from "./cluster";
import { hexToRgb, mixColors, type Rgb, rgbToHex, textOn } from "./colorMix";
import {
	type DashRun,
	type DashState,
	dashRuns,
	newDashState,
	stepDashes,
	traceRun,
	type ZoomStep,
} from "./dashRuns";
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
import { smoothShape } from "./smooth";
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
	| { kind: "cluster"; count: number; bounds: Bounds; color: string };

/** Features are drawn at the centre of their block. */
export const BLOCK_CENTER = 0.5;

/** A cluster grows a little with the number of pins in it. */
const clusterRadius = (count: number) => 13 + Math.min(8, Math.log2(count) * 2);

const ICON_W = 24;
const ICON_H = 24;

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
	/** How a line or area is drawn and hit-tested: end to end, fork to fork, or round a loop. */
	runs: DashRun[];
};
type DrawnPin = { x: number; y: number; item: Prepared };
type PinNode = ClusterNode<Prepared, Rgb>;
type DrawnCluster = {
	x: number;
	y: number;
	r: number;
	count: number;
	bounds: Bounds;
	color: Rgb;
};

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
		bounds: smooth ? smooth.bounds : boundsOf(points),
		runs: feature.type === "pin" ? [] : dashRuns(feature.type, paths, smooth),
	};
}

/** Draws pins (clustered by the world-fixed `ClusterIndex`), lines and polygons, and answers hit-test queries. */
export class FeatureLayer {
	private prepared: Prepared[] = [];
	private clusterPx = DEFAULT_SETTINGS.pinClusterDistance;
	private clusters = this.buildClusters();
	private icons = new Map<Dye, HTMLImageElement>();
	private drawnPins: DrawnPin[] = [];
	private drawnClusters: DrawnCluster[] = [];
	private selectedShown = false;
	/** The feature being edited, drawn in its new shape and style in place of the saved one. */
	private draft: { replaces: number | null; item: Prepared } | null = null;
	/** What is drawn and hit: the prepared features with the draft in the place of the one it replaces. */
	private shown: Prepared[] = [];
	private patterns = new Map<string, CanvasPattern | null>();
	/**
	 * Where the fill patterns are on screen. They keep their size when zooming and only move with
	 * the map when it is panned, so zooming never makes them swim. See `trackView`.
	 */
	private patternShift = { x: 0, y: 0 };
	private lastView: View | null = null;
	/**
	 * Where each dashed line's dashes start (`lineDashOffset`), by feature and stroke. Dashes keep
	 * their size on screen; when zooming, this moves them so that those nearest the point being
	 * zoomed about stay still, as the fill patterns do. See `DashState`.
	 */
	private dashStates = new Map<string, DashState>();
	/** Screen px per block. */
	private scale = 1;
	private zoomStep: ZoomStep | null = null;
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

	/**
	 * How far apart pins may be, in px just after switching to a cluster level, and still merge;
	 * on screen it is between about 0.4 and 0.8 of that.
	 */
	setClusterDistance(px: number) {
		if (px === this.clusterPx) return;
		this.clusterPx = px;
		this.rebuildClusters();
		this.onChange();
	}

	private buildClusters() {
		return new ClusterIndex<Prepared, Rgb>(
			this.prepared
				.filter((p) => p.feature.type === "pin")
				.map((p) => {
					const [x, z] = p.points[0] as Pt;
					return { x, z, item: p, data: hexToRgb(DYE_HEX[this.colorOf(p)]) };
				}),
			{
				radiusPx: this.clusterPx,
				minLevel: MIN_CLUSTER_LEVEL,
				maxLevel: MAX_CLUSTER_LEVEL,
				combine: mixColors,
			},
		);
	}

	private rebuildClusters() {
		this.clusters = this.buildClusters();
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

	/**
	 * Follows the view from the last frame to this one. Between them the screen is scaled about
	 * some point that stays still: on screen for a zoom at the cursor or a pinch, far off (or
	 * nowhere) for a pan. The fill patterns move with the map at that point, or at the nearest
	 * point of the screen, so a zoom leaves them where they are and a pan takes them along.
	 */
	private trackView(view: View, size: Size) {
		const last = this.lastView;
		const from = this.scale;
		this.lastView = view;
		this.scale = scaleOf(view.zoom);
		this.zoomStep = null;
		if (!last) return;
		const k = this.scale / from;
		// Where the screen point `p` was is now at `k * p + t`.
		const tx =
			(size.width / 2) * (1 - k) + (last.centerX - view.centerX) * this.scale;
		const ty =
			(size.height / 2) * (1 - k) + (last.centerZ - view.centerZ) * this.scale;
		let fx = 0;
		let fy = 0;
		if (k !== 1) {
			fx = Math.min(Math.max(tx / (1 - k), 0), size.width);
			fy = Math.min(Math.max(ty / (1 - k), 0), size.height);
			const at = screenToBlock(view, size, fx, fy);
			this.zoomStep = { x: at.x - BLOCK_CENTER, z: at.z - BLOCK_CENTER, from };
		}
		this.patternShift.x =
			(this.patternShift.x + (k - 1) * fx + tx) % PATTERN_SIZE;
		this.patternShift.y =
			(this.patternShift.y + (k - 1) * fy + ty) % PATTERN_SIZE;
	}

	draw(ctx: CanvasRenderingContext2D, view: View, size: Size) {
		this.trackView(view, size);
		this.drawnPins = [];
		this.drawnClusters = [];
		if (this.shown.length === 0) return;

		const viewport = viewportBlocks(view, size, 40 / scaleOf(view.zoom));
		const project = (x: number, z: number) =>
			blockToScreen(view, size, x + BLOCK_CENTER, z + BLOCK_CENTER);

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
		for (const run of p.runs) traceRun(ctx, run, 0, project);
		if (closed && style.fill !== "none") {
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
		const width = emphasised ? emphasisedWidth(style.width) : style.width;
		if (isDraft) {
			// The shape being edited: a solid glow around it, whatever its dash pattern.
			ctx.globalAlpha = 1;
			ctx.strokeStyle = "rgba(255, 232, 102, 0.65)";
			ctx.lineWidth = width + 10;
			ctx.stroke();
		}
		ctx.globalAlpha = style.opacity;
		const outline = () => {
			ctx.strokeStyle = "rgba(0,0,0,0.55)";
			ctx.lineWidth = width + 2;
			ctx.stroke();
			ctx.strokeStyle = hex;
			ctx.lineWidth = width;
			ctx.stroke();
		};
		const dash = dashPattern(style.dash, style.width);
		if (dash.length === 0) {
			outline();
		} else {
			// Each run is stroked on its own, with the offset that keeps its dashes in place.
			const period = dash.reduce((a, b) => a + b, 0);
			const id = isDraft ? "draft" : p.feature.id;
			ctx.setLineDash(dash);
			p.runs.forEach((run, i) => {
				const key = `${id}|${i}`;
				const state = stepDashes(
					run,
					this.dashStates.get(key) ?? newDashState(),
					this.scale,
					period,
					this.zoomStep,
				);
				this.dashStates.set(key, state);
				ctx.beginPath();
				traceRun(ctx, run, state.seam, project);
				ctx.lineDashOffset = state.offset;
				outline();
			});
		}
		ctx.setLineDash([]);
		ctx.lineDashOffset = 0;
		ctx.globalAlpha = 1;
	}

	/** A pattern to fill an area with, in the colour `hex`, at a fixed size on screen. */
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
		// Drawn at the size of a pixel of the screen.
		pattern?.setTransform(
			new DOMMatrix([
				1 / scale,
				0,
				0,
				1 / scale,
				this.patternShift.x,
				this.patternShift.y,
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
						color: node.data,
					});
				this.drawCluster(ctx, s.x, s.y, r, node.count, node.data);
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
		rgb: Rgb,
	) {
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = `rgba(${rgb.map(Math.round).join(",")},0.92)`;
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = "#fff";
		ctx.stroke();
		ctx.fillStyle = textOn(rgb);
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
				return {
					kind: "cluster",
					count: c.count,
					bounds: c.bounds,
					color: rgbToHex(c.color),
				};
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
				p.runs.some((run) => distToPolyline(px, pz, run.samples) <= tolerance)
			)
				return hit(p);
		}
		let inside: Prepared | null = null;
		for (let i = this.shown.length - 1; i >= 0; i--) {
			const p = this.shown[i] as Prepared;
			if (p === this.draft?.item || p.feature.type !== "polygon") continue;
			const tolerance = toleranceOf(p);
			if (!near(p, tolerance)) continue;
			const outline = p.runs[0]?.samples ?? p.points;
			if (distToPolyline(px, pz, outline) <= tolerance) return hit(p);
			// An area without a fill is only there to be clicked on its edge.
			if (
				!inside &&
				resolveStyle(p.feature.style, true, p.layer.style).fill !== "none" &&
				pointInPolygon(px, pz, outline)
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

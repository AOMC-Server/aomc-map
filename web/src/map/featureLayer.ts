import { DYE_HEX, type Dye } from "@aomc/shared/colors";
import {
	blockToScreen,
	type Size,
	scaleOf,
	screenToBlock,
	type View,
} from "@aomc/shared/view";
import { pointsOf } from "../featureInfo";
import { ClusterIndex, type ClusterNode } from "./cluster";
import {
	type Bounds,
	boundsOf,
	distToPolyline,
	intersects,
	type Pt,
	pointInPolygon,
} from "./geometry";
import { viewportBlocks } from "./viewport";

type RenderFeature = {
	id: number;
	layerId: number;
	type: "pin" | "line" | "polygon";
	name: string;
	popup: string;
	color: Dye | null;
	/** pin: [x, z]; line / polygon: [[x, z], ...] */
	geometry: unknown;
};

export type RenderLayer = { id: number; color: Dye; features: RenderFeature[] };

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
const CLUSTER_RADIUS_PX = 56;
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
const LINE_TOLERANCE_PX = 7;

type Prepared = {
	feature: RenderFeature;
	layer: RenderLayer;
	bounds: Bounds;
	points: Pt[];
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

/** Draws pins (clustered by the world-fixed `ClusterIndex`), lines and polygons, and answers hit-test queries. */
export class FeatureLayer {
	private prepared: Prepared[] = [];
	private clusters = new ClusterIndex<Prepared>([], {
		radiusPx: CLUSTER_RADIUS_PX,
		minLevel: MIN_CLUSTER_LEVEL,
		maxLevel: MAX_CLUSTER_LEVEL,
	});
	private icons = new Map<Dye, HTMLImageElement>();
	private drawnPins: DrawnPin[] = [];
	private drawnClusters: DrawnCluster[] = [];
	private selectedShown = false;
	hoveredId: number | null = null;
	selectedId: number | null = null;

	constructor(private onChange: () => void) {}

	setFeatures(layers: RenderLayer[]) {
		this.prepared = layers.flatMap((layer) =>
			layer.features.map((feature) => {
				const points = pointsOf(feature);
				return { feature, layer, points, bounds: boundsOf(points) };
			}),
		);
		this.clusters = new ClusterIndex(
			this.prepared
				.filter((p) => p.feature.type === "pin")
				.map((p) => {
					const [x, z] = p.points[0] as Pt;
					return { x, z, item: p };
				}),
			{
				radiusPx: CLUSTER_RADIUS_PX,
				minLevel: MIN_CLUSTER_LEVEL,
				maxLevel: MAX_CLUSTER_LEVEL,
			},
		);
		this.drawnPins = [];
		this.drawnClusters = [];
		this.onChange();
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
		if (this.prepared.length === 0) return;

		const viewport = viewportBlocks(view, size, 40 / scaleOf(view.zoom));
		const project = (x: number, z: number) =>
			blockToScreen(view, size, x + BLOCK_CENTER, z + BLOCK_CENTER);

		ctx.save();
		ctx.lineJoin = "round";
		ctx.lineCap = "round";

		for (const p of this.prepared) {
			if (!intersects(p.bounds, viewport)) continue;
			if (p.feature.type === "polygon") this.drawShape(ctx, p, project, true);
		}
		for (const p of this.prepared) {
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
		const emphasised =
			p.feature.id === this.hoveredId || p.feature.id === this.selectedId;
		const hex = DYE_HEX[this.colorOf(p)];

		ctx.beginPath();
		let lastX = Number.NaN;
		let lastY = Number.NaN;
		p.points.forEach(([x, z], i) => {
			const s = project(x, z);
			// Skip vertices that fall on the same pixel; huge shapes stay cheap when zoomed out.
			const isEnd = i === p.points.length - 1;
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
		if (closed) {
			ctx.closePath();
			ctx.fillStyle = hex + (emphasised ? "55" : "33");
			ctx.fill();
		}
		const width = emphasised ? 5 : closed ? 2 : 3;
		ctx.strokeStyle = "rgba(0,0,0,0.55)";
		ctx.lineWidth = width + 2;
		ctx.stroke();
		ctx.strokeStyle = hex;
		ctx.lineWidth = width;
		ctx.stroke();
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
				this.drawCluster(ctx, s.x, s.y, r, node.count);
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
	) {
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = "rgba(88,101,242,0.92)";
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
		const tolerance = LINE_TOLERANCE_PX / scaleOf(view.zoom);
		const near = (p: Prepared) => {
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
		for (let i = this.prepared.length - 1; i >= 0; i--) {
			const p = this.prepared[i] as Prepared;
			if (
				p.feature.type === "line" &&
				near(p) &&
				distToPolyline(px, pz, p.points, false) <= tolerance
			)
				return hit(p);
		}
		let inside: Prepared | null = null;
		for (let i = this.prepared.length - 1; i >= 0; i--) {
			const p = this.prepared[i] as Prepared;
			if (p.feature.type !== "polygon" || !near(p)) continue;
			if (distToPolyline(px, pz, p.points, true) <= tolerance) return hit(p);
			if (!inside && pointInPolygon(px, pz, p.points)) inside = p;
		}
		return inside ? hit(inside) : null;
	}
}

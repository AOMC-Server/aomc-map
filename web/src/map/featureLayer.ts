import { DYE_HEX, type Dye } from "@aomc/shared/colors";
import {
	blockToScreen,
	type Size,
	scaleOf,
	screenToBlock,
	type View,
} from "./camera";
import {
	type Bounds,
	boundsOf,
	distToPolyline,
	intersects,
	type Pt,
	pointInPolygon,
} from "./geometry";

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

const ICON_W = 24;
const ICON_H = 24;
const CLUSTER_CELL = 56;
const NO_CLUSTER_BELOW_ZOOM = -3;
const LINE_TOLERANCE_PX = 7;

type Prepared = {
	feature: RenderFeature;
	layer: RenderLayer;
	bounds: Bounds;
	points: Pt[];
};
type DrawnPin = { x: number; y: number; item: Prepared };
type DrawnCluster = {
	x: number;
	y: number;
	r: number;
	count: number;
	bounds: Bounds;
};

const pointsOf = (f: RenderFeature): Pt[] =>
	f.type === "pin" ? [f.geometry as Pt] : (f.geometry as Pt[]);

/** Draws pins (with grid clustering), lines and polygons, and answers hit-test queries. */
export class FeatureLayer {
	private prepared: Prepared[] = [];
	private icons = new Map<Dye, HTMLImageElement>();
	private drawnPins: DrawnPin[] = [];
	private drawnClusters: DrawnCluster[] = [];
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

		const tl = screenToBlock(view, size, 0, 0);
		const br = screenToBlock(view, size, size.width, size.height);
		const margin = 40 / scaleOf(view.zoom);
		const viewport: Bounds = {
			minX: tl.x - margin,
			minZ: tl.z - margin,
			maxX: br.x + margin,
			maxZ: br.z + margin,
		};
		const project = (x: number, z: number) =>
			blockToScreen(view, size, x + BLOCK_CENTER, z + BLOCK_CENTER);

		ctx.save();
		ctx.lineJoin = "round";
		ctx.lineCap = "round";

		const pins: Prepared[] = [];
		for (const p of this.prepared) {
			if (!intersects(p.bounds, viewport)) continue;
			if (p.feature.type === "pin") pins.push(p);
			else if (p.feature.type === "polygon")
				this.drawShape(ctx, p, project, true);
		}
		for (const p of this.prepared) {
			if (p.feature.type === "line" && intersects(p.bounds, viewport)) {
				this.drawShape(ctx, p, project, false);
			}
		}
		this.drawPins(ctx, pins, project, view.zoom > NO_CLUSTER_BELOW_ZOOM);
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

	private drawPins(
		ctx: CanvasRenderingContext2D,
		pins: Prepared[],
		project: (x: number, z: number) => { x: number; y: number },
		cluster: boolean,
	) {
		const cells = new Map<string, { item: Prepared; x: number; y: number }[]>();
		for (const item of pins) {
			const [bx, bz] = item.points[0] as Pt;
			const s = project(bx, bz);
			const key = cluster
				? `${Math.floor(s.x / CLUSTER_CELL)},${Math.floor(s.y / CLUSTER_CELL)}`
				: `${item.feature.id}`;
			const list = cells.get(key) ?? [];
			list.push({ item, x: s.x, y: s.y });
			cells.set(key, list);
		}

		const singles: { item: Prepared; x: number; y: number }[] = [];
		for (const group of cells.values()) {
			if (group.length === 1) {
				singles.push(group[0] as (typeof group)[number]);
				continue;
			}
			const x = group.reduce((n, g) => n + g.x, 0) / group.length;
			const y = group.reduce((n, g) => n + g.y, 0) / group.length;
			const bounds = boundsOf(group.map((g) => g.item.points[0] as Pt));
			const hovered = group.some((g) => g.item.feature.id === this.hoveredId);
			this.drawnClusters.push({ x, y, r: 15, count: group.length, bounds });
			this.drawCluster(ctx, x, y, group.length, hovered);
		}

		for (const s of singles) {
			const { item } = s;
			const emphasised =
				item.feature.id === this.hoveredId ||
				item.feature.id === this.selectedId;
			if (emphasised) {
				ctx.beginPath();
				ctx.arc(s.x, s.y - ICON_H / 2, 17, 0, Math.PI * 2);
				ctx.fillStyle = "rgba(255,255,255,0.35)";
				ctx.fill();
				ctx.strokeStyle = "#fff";
				ctx.lineWidth = 2;
				ctx.stroke();
			}
			const img = this.icon(this.colorOf(item));
			if (img.complete && img.naturalWidth > 0) {
				ctx.imageSmoothingEnabled = false;
				ctx.drawImage(img, s.x - ICON_W / 2, s.y - ICON_H, ICON_W, ICON_H);
			} else {
				ctx.beginPath();
				ctx.arc(s.x, s.y - ICON_H / 2, 6, 0, Math.PI * 2);
				ctx.fillStyle = DYE_HEX[this.colorOf(item)];
				ctx.fill();
			}
			this.drawnPins.push(s);
		}
	}

	private drawCluster(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		count: number,
		hovered: boolean,
	) {
		ctx.beginPath();
		ctx.arc(x, y, hovered ? 17 : 15, 0, Math.PI * 2);
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

	/** Topmost thing under the pointer: clusters and pins first, then lines, then polygons. */
	hitTest(view: View, size: Size, sx: number, sy: number): Hit | null {
		for (let i = this.drawnClusters.length - 1; i >= 0; i--) {
			const c = this.drawnClusters[i] as DrawnCluster;
			if (Math.hypot(sx - c.x, sy - c.y) <= c.r + 2) {
				return { kind: "cluster", count: c.count, bounds: c.bounds };
			}
		}
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

		const at = screenToBlock(view, size, sx, sy);
		const px = at.x - BLOCK_CENTER;
		const pz = at.z - BLOCK_CENTER;
		const tolerance = LINE_TOLERANCE_PX / scaleOf(view.zoom);
		let polygon: Prepared | null = null;
		for (let i = this.prepared.length - 1; i >= 0; i--) {
			const p = this.prepared[i] as Prepared;
			const { type } = p.feature;
			if (type === "pin") continue;
			const b = p.bounds;
			if (
				px < b.minX - tolerance ||
				px > b.maxX + tolerance ||
				pz < b.minZ - tolerance ||
				pz > b.maxZ + tolerance
			) {
				continue;
			}
			if (distToPolyline(px, pz, p.points, type === "polygon") <= tolerance) {
				return { kind: "feature", feature: p.feature, layer: p.layer };
			}
			if (type === "polygon" && !polygon && pointInPolygon(px, pz, p.points))
				polygon = p;
		}
		return polygon
			? { kind: "feature", feature: polygon.feature, layer: polygon.layer }
			: null;
	}

	/** Bounds of a feature in block coordinates, for "go to". */
	boundsOfFeature(id: number): Bounds | null {
		return this.prepared.find((p) => p.feature.id === id)?.bounds ?? null;
	}
}

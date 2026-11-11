import {
	blockToScreen,
	clampZoom,
	panBy,
	type Size,
	screenToBlock,
	type View,
	zoomAt,
} from "@aomc/shared/view";
import { FeatureLayer, type Hit, type RenderLayer } from "./featureLayer";
import type { Bounds } from "./geometry";
import { type DragSession, Input } from "./input";
import { Renderer } from "./renderer";
import { easeZoom, tweenView } from "./smoothZoom";
import { TileLayer, type TileSource } from "./tileLayer";

type MapPointer = { x: number; z: number; sx: number; sy: number };
type ScreenPoint = { x: number; y: number };
export type MapEvents = {
	click: MapPointer & { hit: Hit | null };
	move: MapPointer | null;
	/** Fires when the feature (or cluster) under the mouse changes. */
	hover: { hit: Hit | null; sx: number; sy: number };
	viewchange: View;
};
export type DragHandler = (sx: number, sy: number) => DragSession | null;
export type Overlay = (ctx: CanvasRenderingContext2D, map: MapView) => void;

const DEFAULT_VIEW: View = { centerX: 0, centerZ: 0, zoom: 2 };
/** How many zoom levels an eased zoom may be heading beyond the current view. */
const MAX_ZOOM_LEAD = 2;

/**
 * Framework-free canvas map. The UI only talks to the map through this class.
 * Coordinates are Minecraft blocks (x east, z south); overlays draw in css pixels.
 */
export class MapView {
	readonly canvas = document.createElement("canvas");
	readonly maxZoom: number;
	/** Drawing hooks (css pixel coordinates) that run after the tiles, in order. */
	readonly overlays: Overlay[] = [];
	/** Lets a tool claim pointer-downs (return a session to drag, or null to pan as usual). */
	dragHandler: DragHandler | null = null;
	doubleClickZoom = true;
	private ctx: CanvasRenderingContext2D;
	private view: View;
	private size: Size = { width: 1, height: 1 };
	private dpr = 1;
	private tiles: TileLayer;
	private renderer: Renderer;
	private listeners: {
		[K in keyof MapEvents]: Set<(e: MapEvents[K]) => void>;
	} = {
		click: new Set(),
		move: new Set(),
		hover: new Set(),
		viewchange: new Set(),
	};
	private features: FeatureLayer;
	private hoverKey: string | null = null;
	private baseCursor = "grab";
	/** How long animations take relative to the default; 0 skips them. */
	private motion = 1;
	/** Where an eased zoom (zoomBy) is heading, while one runs. */
	private zoomGoal: {
		zoom: number;
		anchor: ScreenPoint;
		smoothing: number;
	} | null = null;

	constructor(
		private container: HTMLElement,
		opts: { tileSize: number; maxZoom: number; view?: Partial<View> },
	) {
		this.maxZoom = opts.maxZoom;
		this.view = { ...DEFAULT_VIEW, ...stripUndefined(opts.view ?? {}) };
		this.view.zoom = clampZoom(this.view.zoom, this.maxZoom);

		this.canvas.style.cssText =
			"position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block";
		this.canvas.tabIndex = 0;
		container.append(this.canvas);
		this.ctx = this.canvas.getContext("2d", {
			alpha: true,
		}) as CanvasRenderingContext2D;

		this.renderer = new Renderer(() => this.draw());
		this.tiles = new TileLayer({
			tileSize: opts.tileSize,
			maxZoom: opts.maxZoom,
			onChange: () => this.renderer.invalidate(),
		});
		this.features = new FeatureLayer(() => this.renderer.invalidate());
		new Input(this.canvas, this);
		new ResizeObserver(() => this.resize()).observe(container);
		this.resize();
	}

	// Public API

	/** Scales the length of every camera animation (1 = default, 0 = none). */
	setMotionScale(scale: number) {
		this.motion = Math.max(scale, 0);
	}

	getView(): View {
		return { ...this.view };
	}

	setView(next: Partial<View>) {
		const merged = { ...this.view, ...stripUndefined(next) };
		merged.zoom = clampZoom(merged.zoom, this.maxZoom);
		if (
			merged.centerX === this.view.centerX &&
			merged.centerZ === this.view.centerZ &&
			merged.zoom === this.view.zoom
		) {
			return;
		}
		this.view = merged;
		this.renderer.invalidate();
		this.emit("viewchange", this.getView());
	}

	getSize(): Size {
		return { ...this.size };
	}

	clampZoom(zoom: number): number {
		return clampZoom(zoom, this.maxZoom);
	}

	screenToBlock(sx: number, sy: number) {
		return screenToBlock(this.view, this.size, sx, sy);
	}

	blockToScreen(x: number, z: number) {
		return blockToScreen(this.view, this.size, x, z);
	}

	/** keepPrevious: keep showing the old images until the new ones arrive (same content, newer revision). */
	setTileSource(source: TileSource, keepPrevious = false) {
		this.tiles.setSource(source, keepPrevious);
	}

	on<K extends keyof MapEvents>(
		name: K,
		cb: (e: MapEvents[K]) => void,
	): () => void {
		this.listeners[name].add(cb);
		return () => this.listeners[name].delete(cb);
	}

	setCursor(cursor: string) {
		this.baseCursor = cursor;
		this.canvas.style.cursor = cursor;
	}

	/** Replaces the features drawn on the map (only the layers that should be visible). */
	setFeatures(layers: RenderLayer[]) {
		this.features.setFeatures(layers);
	}

	/** Highlights one feature (e.g. the one being edited or shown in a popup). */
	setSelectedFeature(id: number | null) {
		this.features.selectedId = id;
		this.renderer.invalidate();
	}

	/** Draws one feature as hovered (e.g. its row in the layer list is under the mouse). */
	setHoveredFeature(id: number | null) {
		if (this.features.hoveredId === id) return;
		this.features.hoveredId = id;
		this.renderer.invalidate();
	}

	hitTest(sx: number, sy: number): Hit | null {
		return this.features.hitTest(this.view, this.size, sx, sy);
	}

	/** Moves and zooms so that `bounds` fits in the viewport with some padding. */
	fitBounds(
		bounds: Bounds,
		opts: { padding?: number; closestZoom?: number } = {},
	) {
		const pad = opts.padding ?? 80;
		const w = Math.max(bounds.maxX - bounds.minX + 1, 1);
		const h = Math.max(bounds.maxZ - bounds.minZ + 1, 1);
		const availW = Math.max(this.size.width - pad * 2, 50);
		const availH = Math.max(this.size.height - pad * 2, 50);
		// zoom is log2(blocks per pixel); pick the one that fits both axes.
		const fit = Math.log2(Math.max(w / availW, h / availH));
		this.tweenTo(
			{
				centerX: (bounds.minX + bounds.maxX + 1) / 2,
				centerZ: (bounds.minZ + bounds.maxZ + 1) / 2,
				zoom: Math.max(fit, opts.closestZoom ?? -2),
			},
			450,
		);
	}

	invalidate() {
		this.renderer.invalidate();
	}

	// Used by Input

	/** Reports the pointer position: a click, or a move that updates the hover state. */
	pointer(sx: number, sy: number, kind: "move" | "click") {
		const e = { ...this.screenToBlock(sx, sy), sx, sy };
		const hit = this.hitTest(sx, sy);
		if (kind === "click") this.emit("click", { ...e, hit });
		else {
			this.emit("move", e);
			this.updateHover(hit, sx, sy);
		}
	}

	pointerLeft() {
		this.emit("move", null);
		this.updateHover(null, 0, 0);
	}

	cancelAnimation() {
		this.zoomGoal = null;
		this.renderer.stopAnimation();
	}

	/**
	 * Eases the zoom by `delta` levels, keeping `anchor` (screen px) still. Calls made while it is
	 * still easing add to the goal, so a fast scroll keeps gliding instead of jumping per step.
	 * `smoothing` is the easing time constant in ms; lower feels more direct. With `snap`, the goal
	 * is rounded to a multiple of it, so repeated steps end on the same grid of zoom levels.
	 */
	zoomBy(delta: number, anchor: ScreenPoint, smoothing = 80, snap?: number) {
		const base = this.zoomGoal?.zoom ?? this.view.zoom;
		const running = this.zoomGoal !== null;
		// Never more than a couple of levels ahead, so it stops soon after the input does.
		const ahead = Math.min(
			Math.max(base + delta, this.view.zoom - MAX_ZOOM_LEAD),
			this.view.zoom + MAX_ZOOM_LEAD,
		);
		const snapped = snap ? Math.round(ahead / snap) * snap : ahead;
		this.zoomGoal = {
			zoom: clampZoom(snapped, this.maxZoom),
			anchor,
			smoothing: smoothing * this.motion,
		};
		if (running) return;
		let last: number | null = null;
		this.renderer.animate((now) => {
			const goal = this.zoomGoal;
			if (!goal) return false;
			const dt = last === null ? 16 : Math.min(now - last, 50);
			last = now;
			const zoom = easeZoom(this.view.zoom, goal.zoom, dt, goal.smoothing);
			this.setView(
				zoomAt(this.view, this.size, goal.anchor.x, goal.anchor.y, zoom),
			);
			if (zoom !== goal.zoom) return true;
			this.zoomGoal = null;
			return false;
		});
	}

	/** Animates to a view, keeping `anchor` (screen px) stable while zooming. */
	tweenTo(target: View, ms: number, anchor?: ScreenPoint) {
		this.zoomGoal = null;
		const from = this.view;
		const to = { ...target, zoom: clampZoom(target.zoom, this.maxZoom) };
		ms *= this.motion;
		if (ms <= 0) {
			this.renderer.stopAnimation();
			this.setView(to);
			return;
		}
		const began = performance.now();
		this.renderer.animate((now) => {
			const t = Math.min((Math.max(now, began) - began) / ms, 1);
			const e = 1 - (1 - t) ** 3;
			const zoom = from.zoom + (to.zoom - from.zoom) * e;
			if (anchor && from.zoom !== to.zoom) {
				// Zoom about the anchor; apply the remaining pan on top.
				const zoomed = zoomAt(from, this.size, anchor.x, anchor.y, zoom);
				const endZoomed = zoomAt(from, this.size, anchor.x, anchor.y, to.zoom);
				this.setView({
					zoom,
					centerX: zoomed.centerX + (to.centerX - endZoomed.centerX) * e,
					centerZ: zoomed.centerZ + (to.centerZ - endZoomed.centerZ) * e,
				});
			} else {
				this.setView(tweenView(from, to, e));
			}
			return t < 1;
		});
	}

	inertia(vx: number, vy: number) {
		this.zoomGoal = null;
		let last = performance.now();
		this.renderer.animate((now) => {
			const dt = Math.min(now - last, 50);
			last = now;
			this.setView(panBy(this.view, vx * dt, vy * dt));
			const decay = 0.0042 * dt; // exponential friction, frame-rate independent
			vx *= Math.exp(-decay);
			vy *= Math.exp(-decay);
			return Math.hypot(vx, vy) > 0.02;
		});
	}

	// Internals

	private emit<K extends keyof MapEvents>(name: K, e: MapEvents[K]) {
		for (const cb of this.listeners[name]) cb(e);
	}

	private updateHover(hit: Hit | null, sx: number, sy: number) {
		const key = hit
			? hit.kind === "feature"
				? `f${hit.feature.id}`
				: `c${hit.bounds.minX},${hit.bounds.minZ},${hit.count}`
			: null;
		if (key === this.hoverKey) return;
		this.hoverKey = key;
		this.features.hoveredId = hit?.kind === "feature" ? hit.feature.id : null;
		this.canvas.style.cursor = hit ? "pointer" : this.baseCursor;
		this.renderer.invalidate();
		this.emit("hover", { hit, sx, sy });
	}

	private resize() {
		const rect = this.container.getBoundingClientRect();
		const width = Math.max(rect.width, 1);
		const height = Math.max(rect.height, 1);
		const dpr = window.devicePixelRatio || 1;
		if (
			width === this.size.width &&
			height === this.size.height &&
			dpr === this.dpr
		)
			return;
		this.size = { width, height };
		this.dpr = dpr;
		this.canvas.width = Math.round(width * dpr);
		this.canvas.height = Math.round(height * dpr);
		this.renderer.invalidate();
		this.emit("viewchange", this.getView());
	}

	private draw() {
		if ((window.devicePixelRatio || 1) !== this.dpr) this.resize();
		const { ctx, canvas, dpr } = this;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		this.tiles.draw(ctx, this.view, this.size, dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.features.draw(ctx, this.view, this.size);
		for (const overlay of this.overlays) overlay(ctx, this);
	}
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(o).filter(([, v]) => v !== undefined),
	) as Partial<T>;
}

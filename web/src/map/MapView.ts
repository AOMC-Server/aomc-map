import {
	blockToScreen,
	clampZoom,
	MIN_ZOOM,
	panBy,
	type Size,
	screenToBlock,
	type View,
	zoomAt,
} from "./camera";
import { FeatureLayer, type Hit, type RenderLayer } from "./featureLayer";
import type { Bounds } from "./geometry";
import { type DragSession, Input, type InputHost } from "./input";
import { Renderer } from "./renderer";
import { TileLayer, type TileSource } from "./tileLayer";

export type MapPointer = { x: number; z: number; sx: number; sy: number };
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

/**
 * Framework-free canvas map. The UI only talks to the map through this class.
 * Coordinates are Minecraft blocks (x east, z south); overlays draw in css pixels.
 */
export class MapView {
	readonly canvas = document.createElement("canvas");
	private ctx: CanvasRenderingContext2D;
	private view: View;
	private size: Size = { width: 1, height: 1 };
	private dpr = 1;
	private tiles: TileLayer;
	private renderer: Renderer;
	private input: Input;
	private observer: ResizeObserver;
	private listeners: {
		[K in keyof MapEvents]: Set<(e: MapEvents[K]) => void>;
	} = {
		click: new Set(),
		move: new Set(),
		hover: new Set(),
		viewchange: new Set(),
	};
	private overlays = new Map<string, Overlay>();
	private features: FeatureLayer;
	private dragHandler: DragHandler | null = null;
	private hoverKey: string | null = null;
	private baseCursor = "grab";
	private stopAnimation: (() => void) | null = null;
	private dblClickZoom = true;
	readonly maxZoom: number;

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
		this.input = new Input(this.canvas, this.host());
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(container);
		this.resize();
	}

	private host(): InputHost {
		return {
			getView: () => this.view,
			getSize: () => this.size,
			setView: (v) => this.setView(v),
			clampZoom: (z) => clampZoom(z, this.maxZoom),
			stopAnimation: () => this.cancelAnimation(),
			tweenTo: (target, ms, anchor) => this.tweenTo(target, ms, anchor),
			inertia: (vx, vy) => this.inertia(vx, vy),
			pointer: (sx, sy, kind) => {
				const b = this.screenToBlock(sx, sy);
				const e = { ...b, sx, sy };
				const hit = this.hitTest(sx, sy);
				if (kind === "click") this.emit("click", { ...e, hit });
				else {
					this.emit("move", e);
					this.updateHover(hit, sx, sy);
				}
			},
			pointerLeft: () => {
				this.emit("move", null);
				this.updateHover(null, 0, 0);
			},
			doubleClickZoomEnabled: () => this.dblClickZoom,
			beginDrag: (sx, sy) => this.dragHandler?.(sx, sy) ?? null,
		};
	}

	// Public API

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

	screenToBlock(sx: number, sy: number) {
		return screenToBlock(this.view, this.size, sx, sy);
	}

	blockToScreen(x: number, z: number) {
		return blockToScreen(this.view, this.size, x, z);
	}

	setTileSource(
		source: TileSource | null,
		opts: { keepPrevious?: boolean } = {},
	) {
		this.tiles.setSource(source, opts.keepPrevious);
	}

	on<K extends keyof MapEvents>(
		name: K,
		cb: (e: MapEvents[K]) => void,
	): () => void {
		this.listeners[name].add(cb);
		return () => this.listeners[name].delete(cb);
	}

	/** Registers a drawing hook (css pixel coordinates) that runs after the tiles. Pass null to remove. */
	setOverlay(id: string, draw: Overlay | null) {
		if (draw) this.overlays.set(id, draw);
		else this.overlays.delete(id);
		this.renderer.invalidate();
	}

	setDoubleClickZoom(enabled: boolean) {
		this.dblClickZoom = enabled;
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

	getFeatureBounds(id: number): Bounds | null {
		return this.features.boundsOfFeature(id);
	}

	hitTest(sx: number, sy: number): Hit | null {
		return this.features.hitTest(this.view, this.size, sx, sy);
	}

	/** Lets a tool claim pointer-downs (return a session to drag, or null to pan as usual). */
	setDragHandler(handler: DragHandler | null) {
		this.dragHandler = handler;
	}

	/** Moves and zooms so that `bounds` fits in the viewport with some padding. */
	fitBounds(
		bounds: Bounds,
		opts: { padding?: number; closestZoom?: number; ms?: number } = {},
	) {
		const pad = opts.padding ?? 80;
		const w = Math.max(bounds.maxX - bounds.minX + 1, 1);
		const h = Math.max(bounds.maxZ - bounds.minZ + 1, 1);
		const availW = Math.max(this.size.width - pad * 2, 50);
		const availH = Math.max(this.size.height - pad * 2, 50);
		// zoom is log2(blocks per pixel); pick the one that fits both axes.
		const fit = Math.log2(Math.max(w / availW, h / availH));
		const zoom = Math.max(fit, opts.closestZoom ?? -2);
		this.flyTo(
			{
				centerX: (bounds.minX + bounds.maxX + 1) / 2,
				centerZ: (bounds.minZ + bounds.maxZ + 1) / 2,
				zoom,
			},
			opts.ms ?? 450,
		);
	}

	/** Animates to a view, keeping `anchor` (screen px, default centre) stable while zooming. */
	flyTo(target: Partial<View>, ms = 400) {
		this.tweenTo({ ...this.view, ...stripUndefined(target) }, ms);
	}

	invalidate() {
		this.renderer.invalidate();
	}

	destroy() {
		this.cancelAnimation();
		this.input.destroy();
		this.observer.disconnect();
		this.renderer.destroy();
		this.tiles.dispose();
		this.canvas.remove();
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

	private cancelAnimation() {
		this.stopAnimation?.();
		this.stopAnimation = null;
	}

	private tweenTo(target: View, ms: number, anchor?: { x: number; y: number }) {
		this.cancelAnimation();
		const from = this.view;
		const to = { ...target, zoom: clampZoom(target.zoom, this.maxZoom) };
		const began = performance.now();
		this.stopAnimation = this.renderer.animate((now) => {
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
				this.setView({
					zoom,
					centerX: from.centerX + (to.centerX - from.centerX) * e,
					centerZ: from.centerZ + (to.centerZ - from.centerZ) * e,
				});
			}
			return t < 1;
		});
	}

	private inertia(vx: number, vy: number) {
		this.cancelAnimation();
		let last = performance.now();
		this.stopAnimation = this.renderer.animate((now) => {
			const dt = Math.min(now - last, 50);
			last = now;
			this.setView(panBy(this.view, vx * dt, vy * dt));
			const decay = 0.0042 * dt; // exponential friction, frame-rate independent
			vx *= Math.exp(-decay);
			vy *= Math.exp(-decay);
			return Math.hypot(vx, vy) > 0.02;
		});
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
		for (const overlay of this.overlays.values()) overlay(ctx, this);
	}
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(o).filter(([, v]) => v !== undefined),
	) as Partial<T>;
}

export { MIN_ZOOM };

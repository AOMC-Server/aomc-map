import { panBy, type Size, type View, zoomAt } from "./camera";

export interface InputHost {
	getView(): View;
	getSize(): Size;
	setView(view: View): void;
	clampZoom(zoom: number): number;
	/** Cancels any running tween or inertia. */
	stopAnimation(): void;
	tweenTo(target: View, ms: number, anchor?: { x: number; y: number }): void;
	inertia(vx: number, vy: number): void;
	pointer(sx: number, sy: number, kind: "move" | "click"): void;
	pointerLeft(): void;
	doubleClickZoomEnabled(): boolean;
	/** Lets a tool claim a pointer-down (e.g. to drag a vertex) instead of panning the map. */
	beginDrag(sx: number, sy: number): DragSession | null;
}

export type DragSession = { move(sx: number, sy: number): void; end(): void };

const DRAG_THRESHOLD = 5;
const INERTIA_MIN_SPEED = 0.15; // px per ms

type Pt = { x: number; y: number };

/** Pointer, wheel and keyboard handling for the map element. */
export class Input {
	private pointers = new Map<number, Pt>();
	private start: (Pt & { t: number }) | null = null;
	private moved = false;
	private velocity: Pt = { x: 0, y: 0 };
	private lastMove = 0;
	private lastPinch: { dist: number; mid: Pt } | null = null;
	private session: DragSession | null = null;
	private cleanup: (() => void)[] = [];

	constructor(
		private el: HTMLElement,
		private host: InputHost,
	) {
		this.on(el, "pointerdown", this.down);
		this.on(el, "pointermove", this.move);
		this.on(el, "pointerup", this.up);
		this.on(el, "pointercancel", this.cancel);
		this.on(el, "pointerleave", () => {
			if (this.pointers.size === 0) host.pointerLeft();
		});
		this.on(el, "wheel", this.wheel, { passive: false });
		this.on(el, "dblclick", this.dblclick);
		this.on(el, "contextmenu", (e) => e.preventDefault());
		this.on(window, "keydown", this.key);
	}

	private on<E extends Event>(
		target: EventTarget,
		type: string,
		fn: (e: E) => void,
		options?: AddEventListenerOptions,
	) {
		const handler = fn as unknown as EventListener;
		target.addEventListener(type, handler, options);
		this.cleanup.push(() => target.removeEventListener(type, handler, options));
	}

	private local(e: PointerEvent | MouseEvent | WheelEvent): Pt {
		const r = this.el.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private down = (e: PointerEvent) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		this.host.stopAnimation();
		this.el.setPointerCapture(e.pointerId);
		const p = this.local(e);
		this.pointers.set(e.pointerId, p);
		if (this.pointers.size === 1) {
			this.session = this.host.beginDrag(p.x, p.y);
			if (this.session) return;
			this.start = { ...p, t: performance.now() };
			this.moved = false;
			this.velocity = { x: 0, y: 0 };
			this.lastMove = performance.now();
		} else if (this.pointers.size === 2) {
			this.endSession();
			this.moved = true;
			this.lastPinch = this.pinchState();
		}
	};

	private pinchState() {
		const [a, b] = [...this.pointers.values()] as [Pt, Pt];
		return {
			dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
			mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
		};
	}

	private move = (e: PointerEvent) => {
		const p = this.local(e);
		if (!this.pointers.has(e.pointerId)) {
			if (e.pointerType === "mouse") this.host.pointer(p.x, p.y, "move");
			return;
		}
		const prev = this.pointers.get(e.pointerId) as Pt;
		this.pointers.set(e.pointerId, p);
		if (this.session) {
			this.session.move(p.x, p.y);
			return;
		}

		if (this.pointers.size >= 2 && this.lastPinch) {
			const next = this.pinchState();
			let view = this.host.getView();
			const zoom = this.host.clampZoom(
				view.zoom - Math.log2(next.dist / this.lastPinch.dist),
			);
			view = zoomAt(view, this.host.getSize(), next.mid.x, next.mid.y, zoom);
			view = panBy(
				view,
				next.mid.x - this.lastPinch.mid.x,
				next.mid.y - this.lastPinch.mid.y,
			);
			this.host.setView(view);
			this.lastPinch = next;
			return;
		}

		if (this.pointers.size === 1 && this.start) {
			if (
				!this.moved &&
				Math.hypot(p.x - this.start.x, p.y - this.start.y) > DRAG_THRESHOLD
			) {
				this.moved = true;
			}
			if (!this.moved) return;
			const now = performance.now();
			const dt = Math.max(now - this.lastMove, 1);
			const dx = p.x - prev.x;
			const dy = p.y - prev.y;
			// Smoothed velocity in px/ms.
			this.velocity = {
				x: 0.7 * (dx / dt) + 0.3 * this.velocity.x,
				y: 0.7 * (dy / dt) + 0.3 * this.velocity.y,
			};
			this.lastMove = now;
			this.host.setView(panBy(this.host.getView(), dx, dy));
			if (e.pointerType === "mouse") this.host.pointer(p.x, p.y, "move");
		}
	};

	private endSession() {
		this.session?.end();
		this.session = null;
	}

	private up = (e: PointerEvent) => {
		const p = this.local(e);
		const wasSingle = this.pointers.size === 1;
		this.pointers.delete(e.pointerId);
		if (this.session) {
			this.endSession();
			return;
		}
		if (this.pointers.size === 1) {
			// Pinch ended with one finger left: continue as a drag from there.
			this.lastPinch = null;
			this.start = null;
		}
		if (!wasSingle || !this.start) return;
		const start = this.start;
		this.start = null;

		if (!this.moved) {
			this.host.pointer(p.x, p.y, "click");
			return;
		}
		const idle = performance.now() - this.lastMove;
		const speed = Math.hypot(this.velocity.x, this.velocity.y);
		if (
			idle < 80 &&
			speed > INERTIA_MIN_SPEED &&
			performance.now() - start.t > 30
		) {
			this.host.inertia(this.velocity.x, this.velocity.y);
		}
	};

	private cancel = (e: PointerEvent) => {
		this.endSession();
		this.pointers.delete(e.pointerId);
		this.start = null;
		this.lastPinch = null;
	};

	private wheel = (e: WheelEvent) => {
		e.preventDefault();
		this.host.stopAnimation();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
		const factor = e.ctrlKey ? 0.02 : 0.005; // ctrl+wheel is a trackpad pinch
		const p = this.local(e);
		const view = this.host.getView();
		const zoom = this.host.clampZoom(view.zoom + e.deltaY * unit * factor);
		this.host.setView(zoomAt(view, this.host.getSize(), p.x, p.y, zoom));
	};

	private dblclick = (e: MouseEvent) => {
		if (!this.host.doubleClickZoomEnabled()) return;
		const p = this.local(e);
		const view = this.host.getView();
		const zoom = this.host.clampZoom(view.zoom - 1);
		this.host.tweenTo({ ...view, zoom }, 220, p);
	};

	private key = (e: KeyboardEvent) => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (
			t &&
			(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
		)
			return;
		const view = this.host.getView();
		const size = this.host.getSize();
		const step = e.shiftKey ? 400 : 120;
		const pan = (dx: number, dy: number) => {
			const target = panBy(view, dx, dy);
			this.host.tweenTo(target, 140);
		};
		const zoomBy = (delta: number) => {
			const zoom = this.host.clampZoom(view.zoom + delta);
			this.host.tweenTo({ ...view, zoom }, 180, {
				x: size.width / 2,
				y: size.height / 2,
			});
		};
		switch (e.key) {
			case "ArrowLeft":
				pan(step, 0);
				break;
			case "ArrowRight":
				pan(-step, 0);
				break;
			case "ArrowUp":
				pan(0, step);
				break;
			case "ArrowDown":
				pan(0, -step);
				break;
			case "+":
			case "=":
				zoomBy(-1);
				break;
			case "-":
			case "_":
				zoomBy(1);
				break;
			default:
				return;
		}
		e.preventDefault();
	};

	destroy() {
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
	}
}

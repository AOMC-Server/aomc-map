import { panBy, zoomAt } from "@aomc/shared/view";
import type { MapView } from "./MapView";

/**
 * A drag started by a tool. `end` is the pointer lifting (a press that never moved is a click);
 * `cancel` is the gesture being taken away (a second finger lands, the browser cancels the
 * pointer), which must not count as a click.
 */
export type DragSession = {
	move(sx: number, sy: number): void;
	end(): void;
	cancel(): void;
};

/** True for key events aimed at a text field, which the map must leave alone. */
export function isTyping(target: EventTarget | null): boolean {
	const t = target as HTMLElement | null;
	return (
		!!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
	);
}

/** True for key events the UI owns: aimed at a text field, or inside a panel, dialog, popup or menu. */
export function isUiKeyTarget(target: EventTarget | null): boolean {
	return (
		isTyping(target) ||
		!!(target as Element | null)?.closest?.(
			".panel, .modal, .popup, .context-menu",
		)
	);
}

/** True for focused controls, which use Enter (and Space) themselves. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
	return !!(target as Element | null)?.closest?.(
		"button, a, input, textarea, select, [contenteditable]",
	);
}

/** Zoom steps from the wheel, keys and double-click end on multiples of this. */
const ZOOM_GRID = 0.5;
const DRAG_THRESHOLD = 5;
const INERTIA_MIN_SPEED = 0.15; // px per ms
/** Fastest a released drag keeps gliding, so a hard flick doesn't fling the map away. */
const INERTIA_MAX_SPEED = 4; // px per ms
/** How far back the drag speed is measured when the pointer lifts, in ms. */
const DRAG_WINDOW = 80;
/** A pointer held still for this long before lifting stops the map instead of flinging it. */
const RELEASE_HOLD = 50;
/** Pinch speed below which lifting the fingers just stops the zoom, in levels per ms. */
const ZOOM_INERTIA_MIN_SPEED = 0.0008;
/** Fastest a released pinch keeps zooming, in levels per ms (about a level of glide). */
const ZOOM_INERTIA_MAX_SPEED = 0.006;
/** How far back the pinch speed is measured when the fingers lift, in ms. */
const PINCH_WINDOW = 100;

type Pt = { x: number; y: number };
type PinchSample = { t: number; zoom: number; mid: Pt };

/** Pointer, wheel and keyboard handling for the map element. */
export class Input {
	private pointers = new Map<number, Pt>();
	private start: (Pt & { t: number }) | null = null;
	private moved = false;
	/** Recent drag positions with their event times, to measure its speed when the pointer lifts. */
	private dragSamples: (Pt & { t: number })[] = [];
	private lastPinch: { dist: number; mid: Pt } | null = null;
	/** Recent pinch positions, to measure its speed when the fingers lift. */
	private pinchSamples: PinchSample[] = [];
	private session: DragSession | null = null;

	constructor(
		private el: HTMLElement,
		private map: MapView,
	) {
		el.addEventListener("pointerdown", this.down);
		el.addEventListener("pointermove", this.move);
		el.addEventListener("pointerup", this.up);
		el.addEventListener("pointercancel", this.cancel);
		el.addEventListener("pointerleave", () => {
			if (this.pointers.size === 0) map.pointerLeft();
		});
		el.addEventListener("wheel", this.wheel, { passive: false });
		el.addEventListener("dblclick", this.dblclick);
		el.addEventListener("contextmenu", this.contextmenu);
		window.addEventListener("keydown", this.key);
	}

	private local(e: PointerEvent | MouseEvent | WheelEvent): Pt {
		const r = this.el.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private down = (e: PointerEvent) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		this.map.cancelAnimation();
		this.el.setPointerCapture(e.pointerId);
		const p = this.local(e);
		this.pointers.set(e.pointerId, p);
		if (this.pointers.size === 1) {
			this.session = this.map.dragHandler?.(p.x, p.y) ?? null;
			if (this.session) {
				this.map.setGrabbing(true);
				return;
			}
			this.start = { ...p, t: performance.now() };
			this.moved = false;
			this.dragSamples = [{ ...p, t: e.timeStamp }];
		} else if (this.pointers.size === 2) {
			this.cancelSession();
			this.moved = true;
			this.lastPinch = this.pinchState();
			this.pinchSamples = [];
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
			if (e.pointerType === "mouse") this.map.pointer(p.x, p.y, "move");
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
			let view = this.map.getView();
			const zoom = this.map.clampZoom(
				view.zoom - Math.log2(next.dist / this.lastPinch.dist),
			);
			view = zoomAt(view, this.map.getSize(), next.mid.x, next.mid.y, zoom);
			view = panBy(
				view,
				next.mid.x - this.lastPinch.mid.x,
				next.mid.y - this.lastPinch.mid.y,
			);
			this.map.setView(view);
			this.lastPinch = next;
			this.recordPinch(next.mid);
			return;
		}

		if (this.pointers.size === 1 && this.start) {
			if (
				!this.moved &&
				Math.hypot(p.x - this.start.x, p.y - this.start.y) > DRAG_THRESHOLD
			) {
				this.moved = true;
				this.map.setGrabbing(true);
			}
			this.recordDrag(e);
			if (!this.moved) return;
			this.map.setView(panBy(this.map.getView(), p.x - prev.x, p.y - prev.y));
			if (e.pointerType === "mouse") this.map.pointer(p.x, p.y, "move");
		}
	};

	/**
	 * Remembers where the drag was and when. Touch screens report several positions per event
	 * (one per hardware sample); using them all gives a steadier speed than one per frame.
	 */
	private recordDrag(e: PointerEvent) {
		const events = e.getCoalescedEvents?.() ?? [];
		for (const c of events.length > 0 ? events : [e])
			this.dragSamples.push({ ...this.local(c), t: c.timeStamp });
		const t = e.timeStamp;
		while (
			this.dragSamples.length > 2 &&
			(this.dragSamples[0] as Pt & { t: number }).t < t - DRAG_WINDOW
		)
			this.dragSamples.shift();
	}

	/** The drag's speed in px per ms just before it was released at `t`, or null if it had stopped. */
	private releaseVelocity(t: number): Pt | null {
		const samples = this.dragSamples;
		this.dragSamples = [];
		const last = samples.at(-1);
		if (!last || t - last.t > RELEASE_HOLD) return null;
		// Measure from the oldest sample still inside the window, so a single jittery event
		// between two frames can't decide the direction or speed of the glide.
		const first = samples.find((s) => s.t >= last.t - DRAG_WINDOW);
		if (!first || first === last) return null;
		const dt = last.t - first.t;
		if (dt < 8) return null;
		let vx = (last.x - first.x) / dt;
		let vy = (last.y - first.y) / dt;
		const speed = Math.hypot(vx, vy);
		if (speed < INERTIA_MIN_SPEED) return null;
		if (speed > INERTIA_MAX_SPEED) {
			vx *= INERTIA_MAX_SPEED / speed;
			vy *= INERTIA_MAX_SPEED / speed;
		}
		return { x: vx, y: vy };
	}

	private recordPinch(mid: Pt) {
		const t = performance.now();
		this.pinchSamples.push({ t, zoom: this.map.getView().zoom, mid });
		while (
			this.pinchSamples.length > 2 &&
			(this.pinchSamples[0] as PinchSample).t < t - PINCH_WINDOW
		)
			this.pinchSamples.shift();
	}

	/** Keeps a pinch zooming for a moment after the fingers lift, if it was moving fast enough. */
	private releasePinch() {
		const samples = this.pinchSamples;
		this.pinchSamples = [];
		const now = performance.now();
		const first = samples.find((s) => s.t >= now - PINCH_WINDOW);
		const last = samples.at(-1);
		if (!first || !last || first === last || now - last.t > RELEASE_HOLD)
			return;
		const dt = Math.max(last.t - first.t, 1);
		const raw = (last.zoom - first.zoom) / dt;
		const vz =
			Math.abs(raw) < ZOOM_INERTIA_MIN_SPEED
				? 0
				: Math.sign(raw) * Math.min(Math.abs(raw), ZOOM_INERTIA_MAX_SPEED);
		let vx = (last.mid.x - first.mid.x) / dt;
		let vy = (last.mid.y - first.mid.y) / dt;
		if (Math.hypot(vx, vy) < INERTIA_MIN_SPEED) {
			vx = 0;
			vy = 0;
		}
		if (vz === 0 && vx === 0 && vy === 0) return;
		this.map.zoomInertia(vz, last.mid, vx, vy);
	}

	private endSession() {
		this.session?.end();
		this.session = null;
		this.map.setGrabbing(false);
	}

	private cancelSession() {
		this.session?.cancel();
		this.session = null;
		this.map.setGrabbing(false);
	}

	/**
	 * A finger lifted while others stay down. With two or more left the pinch carries on from
	 * where they are now; with one left it continues as a drag from there.
	 */
	private rebase(t: number, release: boolean) {
		this.pinchSamples = [];
		const rest = this.pointers.values().next().value;
		if (this.pointers.size >= 2) {
			this.lastPinch = this.pinchState();
			return;
		}
		if (this.lastPinch && release) this.releasePinch();
		this.lastPinch = null;
		if (!rest) return;
		this.start = { ...rest, t: performance.now() };
		this.moved = true;
		this.dragSamples = [{ ...rest, t }];
	}

	private up = (e: PointerEvent) => {
		const p = this.local(e);
		const wasSingle = this.pointers.size === 1;
		if (!this.pointers.delete(e.pointerId)) return;
		if (this.session) {
			this.endSession();
			return;
		}
		if (this.pointers.size > 0) {
			this.rebase(e.timeStamp, true);
			return;
		}
		this.map.setGrabbing(false);
		if (!wasSingle || !this.start) return;
		this.start = null;

		if (!this.moved) {
			this.map.pointer(p.x, p.y, "click");
			return;
		}
		const v = this.releaseVelocity(e.timeStamp);
		if (v) this.map.inertia(v.x, v.y);
	};

	private cancel = (e: PointerEvent) => {
		if (!this.pointers.delete(e.pointerId)) return;
		this.cancelSession();
		if (this.pointers.size > 0) {
			this.rebase(e.timeStamp, false);
			return;
		}
		this.map.setGrabbing(false);
		this.start = null;
		this.lastPinch = null;
		this.pinchSamples = [];
		this.dragSamples = [];
	};

	private wheel = (e: WheelEvent) => {
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
		const delta = e.deltaY * unit;
		if (delta === 0) return; // a sideways tilt of the wheel
		const factor = e.ctrlKey ? 0.02 : 0.005; // ctrl+wheel is a trackpad pinch
		// A mouse wheel moves in big notches, which are eased out. Trackpads already send a smooth
		// stream of small steps, so they only get a little easing to stay direct under the fingers.
		const notched = !e.ctrlKey && (e.deltaMode !== 0 || Math.abs(delta) >= 40);
		// Notches snap to half levels; the pin clusters are laid out around that grid.
		this.map.zoomBy(
			delta * factor,
			this.local(e),
			notched ? 80 : 30,
			notched ? ZOOM_GRID : undefined,
		);
	};

	/**
	 * A right click, or a long press on touch screens. The press that opened it (a long press, or
	 * Ctrl+click on a Mac) must not also count as a click when it lifts.
	 */
	private contextmenu = (e: MouseEvent) => {
		e.preventDefault();
		// Not in the middle of dragging or pinching the map.
		if (this.session || this.pointers.size > 1) return;
		if (this.pointers.size === 1 && this.moved) return;
		this.start = null;
		const p = this.local(e);
		this.map.contextMenu(p.x, p.y);
	};

	private dblclick = (e: MouseEvent) => {
		if (!this.map.doubleClickZoom) return;
		this.map.zoomBy(-1, this.local(e), 70, ZOOM_GRID);
	};

	private key = (e: KeyboardEvent) => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (isUiKeyTarget(e.target)) return;
		const view = this.map.getView();
		const size = this.map.getSize();
		const step = e.shiftKey ? 400 : 120;
		const pan = (dx: number, dy: number) => {
			const target = panBy(view, dx, dy);
			this.map.tweenTo(target, 140);
		};
		const zoomBy = (delta: number) =>
			this.map.zoomBy(
				delta,
				{ x: size.width / 2, y: size.height / 2 },
				70,
				ZOOM_GRID,
			);
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
}

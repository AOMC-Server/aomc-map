export type Animation = (now: number) => boolean;

type Running = {
	fn: Animation;
	label: string;
	/** Called once when it stops: "done", "replaced by <label>", or why it was stopped. */
	onEnd?: (why: string) => void;
};

/** requestAnimationFrame loop that only draws when something changed or an animation runs. */
export class Renderer {
	private dirty = true;
	private raf = 0;
	private animation: Running | null = null;

	constructor(
		private draw: () => void,
		/** A frame threw. The loop carries on, so one bad frame does not freeze an animation. */
		private onError: (err: unknown) => void = (err) => console.error(err),
	) {}

	invalidate() {
		this.dirty = true;
		this.schedule();
	}

	/** Runs `fn` every frame until it returns false, replacing any animation already running. */
	animate(fn: Animation, label = "animation", onEnd?: (why: string) => void) {
		const previous = this.animation;
		this.animation = { fn, label, onEnd };
		previous?.onEnd?.(`replaced by ${label}`);
		this.schedule();
	}

	stopAnimation(why = "stopped") {
		const previous = this.animation;
		this.animation = null;
		previous?.onEnd?.(why);
	}

	private schedule() {
		if (!this.raf) this.raf = requestAnimationFrame((now) => this.frame(now));
	}

	private frame(now: number) {
		this.raf = 0;
		const animation = this.animation;
		if (animation) {
			let more = false;
			try {
				more = animation.fn(now);
			} catch (err) {
				this.onError(err);
			}
			if (!more && this.animation === animation) {
				this.animation = null;
				animation.onEnd?.("done");
			}
			this.dirty = true;
		}
		if (this.dirty) {
			this.dirty = false;
			try {
				this.draw();
			} catch (err) {
				this.onError(err);
			}
		}
		if (this.animation) this.schedule();
	}
}

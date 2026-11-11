export type Animation = (now: number) => boolean;

/** requestAnimationFrame loop that only draws when something changed or an animation runs. */
export class Renderer {
	private dirty = true;
	private raf = 0;
	private animation: Animation | null = null;

	constructor(private draw: () => void) {}

	invalidate() {
		this.dirty = true;
		this.schedule();
	}

	/** Runs `fn` every frame until it returns false, replacing any animation already running. */
	animate(fn: Animation) {
		this.animation = fn;
		this.schedule();
	}

	stopAnimation() {
		this.animation = null;
	}

	private schedule() {
		if (!this.raf) this.raf = requestAnimationFrame((now) => this.frame(now));
	}

	private frame(now: number) {
		this.raf = 0;
		const animation = this.animation;
		if (animation) {
			if (!animation(now) && this.animation === animation)
				this.animation = null;
			this.dirty = true;
		}
		if (this.dirty) {
			this.dirty = false;
			this.draw();
		}
		if (this.animation) this.schedule();
	}
}

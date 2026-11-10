export type Animation = (now: number) => boolean;

/** requestAnimationFrame loop that only draws when something changed or an animation runs. */
export class Renderer {
	private dirty = true;
	private raf = 0;
	private animations = new Set<Animation>();

	constructor(private draw: () => void) {}

	invalidate() {
		this.dirty = true;
		this.schedule();
	}

	/** The animation is called every frame until it returns false. */
	animate(fn: Animation): () => void {
		this.animations.add(fn);
		this.schedule();
		return () => this.animations.delete(fn);
	}

	private schedule() {
		if (!this.raf) this.raf = requestAnimationFrame((now) => this.frame(now));
	}

	private frame(now: number) {
		this.raf = 0;
		for (const fn of [...this.animations]) {
			if (!fn(now)) this.animations.delete(fn);
			this.dirty = true;
		}
		if (this.dirty) {
			this.dirty = false;
			this.draw();
		}
		if (this.animations.size > 0) this.schedule();
	}

	destroy() {
		cancelAnimationFrame(this.raf);
		this.animations.clear();
	}
}

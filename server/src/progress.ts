export type ProgressEvent = {
	status: "pending" | "processing" | "done" | "failed";
	message?: string;
	done?: number;
	total?: number;
	rev?: number | null;
	error?: string | null;
};

export type ProgressBus = ReturnType<typeof createProgressBus>;

/** In-memory fan-out of job progress, keyed by revision id. */
export function createProgressBus() {
	const listeners = new Map<number, Set<(event: ProgressEvent) => void>>();
	return {
		emit(revisionId: number, event: ProgressEvent) {
			for (const fn of listeners.get(revisionId) ?? []) fn(event);
		},
		subscribe(
			revisionId: number,
			fn: (event: ProgressEvent) => void,
		): () => void {
			const set = listeners.get(revisionId) ?? new Set();
			listeners.set(revisionId, set);
			set.add(fn);
			return () => {
				set.delete(fn);
				if (set.size === 0) listeners.delete(revisionId);
			};
		},
	};
}

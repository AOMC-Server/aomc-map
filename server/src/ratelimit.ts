/** Fixed-window in-memory limiter. `hit` returns false once the key is over its limit. */
export function createRateLimiter(limit: number, windowMs = 60_000) {
	const windows = new Map<string, { start: number; count: number }>();
	return {
		hit(key: string, now = Date.now()): boolean {
			const w = windows.get(key);
			if (!w || now - w.start >= windowMs) {
				windows.set(key, { start: now, count: 1 });
				if (windows.size > 10_000) {
					for (const [k, v] of windows)
						if (now - v.start >= windowMs) windows.delete(k);
				}
				return true;
			}
			w.count++;
			return w.count <= limit;
		},
	};
}

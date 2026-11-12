export type ProgressStep = { message?: string; done?: number; total?: number };

/**
 * Passes progress on at most every `ms`, except for a new message or the last step, so a job
 * that reports every tile does not flood the streams following it.
 */
export function throttled<P extends ProgressStep>(
	emit: (p: P) => void,
	ms = 100,
) {
	let lastAt = 0;
	let lastMessage: string | undefined;
	return (p: P) => {
		const now = Date.now();
		if (
			p.message !== lastMessage ||
			p.done === undefined ||
			p.done === p.total ||
			now - lastAt >= ms
		) {
			lastAt = now;
			lastMessage = p.message;
			emit(p);
		}
	};
}

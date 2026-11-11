export type PollResult<T> =
	| { done: true; value: T }
	| { done: false; reason: "timeout" | "aborted" };

/** Waits `ms`, or less if the signal aborts. */
export const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish);
	});

/**
 * Calls `check` every `intervalMs` until it returns something other than undefined. Gives up
 * after `timeoutMs`, or as soon as the signal aborts.
 */
export async function pollUntil<T>(
	check: () => Promise<T | undefined>,
	opts: { intervalMs: number; timeoutMs: number; signal?: AbortSignal },
): Promise<PollResult<T>> {
	const deadline = Date.now() + opts.timeoutMs;
	for (;;) {
		if (opts.signal?.aborted) return { done: false, reason: "aborted" };
		const value = await check();
		if (value !== undefined) return { done: true, value };
		if (Date.now() + opts.intervalMs > deadline)
			return { done: false, reason: "timeout" };
		await sleep(opts.intervalMs, opts.signal);
	}
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, and returns the results in input
 * order. On the first error no new calls start; it is thrown once the running ones have settled,
 * so nothing keeps working in the background after the caller has given up.
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failure: { error: unknown } | null = null;
	const lane = async () => {
		while (failure === null && next < items.length) {
			const i = next++;
			try {
				results[i] = await fn(items[i] as T, i);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	const lanes = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: lanes }, lane));
	if (failure) throw (failure as { error: unknown }).error;
	return results;
}

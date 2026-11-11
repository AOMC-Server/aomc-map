/**
 * A command-line option that must be a positive number. `Number("1h")` is NaN, which would
 * silently turn comparisons into "always false", so anything else is rejected.
 */
export function positiveNumber(
	name: string,
	raw: string | number,
	opts: { integer?: boolean } = {},
): number {
	const text = String(raw).trim();
	const n = text === "" ? Number.NaN : Number(text);
	if (!Number.isFinite(n) || n <= 0 || (opts.integer && !Number.isInteger(n))) {
		throw new Error(
			`--${name} must be a positive ${opts.integer ? "whole " : ""}number, got "${raw}"`,
		);
	}
	return n;
}

/** Runs a command-line parse step; a bad option prints its message and exits with status 2. */
export function orExit<T>(parse: () => T): T {
	try {
		return parse();
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(2);
	}
}

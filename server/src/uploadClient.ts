/** Case, spaces, underscores and hyphens don't matter: "AOMC Visited" matches "aomc-visited/1.0". */
const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
const escapeRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether an upload came from the in-game mod, by its User-Agent. A pattern matches anywhere in
 * it and may use `*` as a wildcard. Anyone can send any header, so this is for statistics only.
 */
export function isModClient(
	userAgent: string | undefined,
	patterns: string[],
): boolean {
	if (!userAgent) return false;
	const agent = squash(userAgent);
	return patterns.some((pattern) => {
		const squashed = squash(pattern);
		if (squashed.replace(/\*/g, "") === "") return false;
		return new RegExp(squashed.split("*").map(escapeRegex).join(".*")).test(
			agent,
		);
	});
}

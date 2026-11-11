/** Text of a scale field -> number, null (no relevant scale), or undefined (not a valid entry). */
export function parseScale(text: string): number | null | undefined {
	const t = text.trim().toLowerCase();
	if (t === "" || t === "none" || t === "-" || t === "n/a") return null;
	if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
	const n = Number(t);
	return n > 0 && n <= 1_000_000 ? n : undefined;
}

export const formatScale = (scale: number | null): string =>
	scale === null ? "" : String(scale);

/** One-line explanation for the settings UI. */
export function describeDimensionScale(scale: number | null): string {
	if (scale === null)
		return "No scale: coordinates can't be compared with other dimensions";
	if (scale === 1) return "Same coordinates as the overworld";
	return `1 block here = ${scale} overworld blocks`;
}

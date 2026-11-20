/** Side of the tile of the patterns that fill areas, in screen pixels. */
export const PATTERN_SIZE = 8;

export type PatternFill = "stripes" | "crosshatch" | "dots";

/**
 * One tile of a fill pattern as SVG markup, in the colour `hex`: what the map's canvas draws, for
 * the link previews and the style pickers. The lines run through the corners too, so tiles join up.
 */
export function fillPatternMarkup(fill: PatternFill, hex: string): string {
	const s = PATTERN_SIZE;
	if (fill === "dots")
		return `<circle cx="${s / 2}" cy="${s / 2}" r="1.6" fill="${hex}"/>`;
	const crosshatch =
		fill === "crosshatch"
			? `M0 0L${s} ${s}M-1 ${s - 1}L1 ${s + 1}M${s - 1} -1L${s + 1} 1`
			: "";
	return `<path d="M0 ${s}L${s} 0M-1 1L1 -1M${s - 1} ${s + 1}L${s + 1} ${s - 1}${crosshatch}" stroke="${hex}" stroke-width="1.5" fill="none"/>`;
}

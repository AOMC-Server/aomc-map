/** The Minecraft font is drawn on a grid of 12 pixels per em. */
const FONT_GRID = 12;
/** Preferred size in CSS pixels; the result is the closest size that stays crisp. */
const TARGET_PX = 18;

/**
 * CSS font size at which one font pixel covers a whole number of device pixels, so the pixel
 * font is drawn without blurry edges: 24 px at a pixel ratio of 1, 18 px at 2, 16 px at 1.5.
 */
export function fontSizeFor(devicePixelRatio: number): number {
	const scale = Math.max(
		1,
		Math.round((TARGET_PX * devicePixelRatio) / FONT_GRID),
	);
	return (scale * FONT_GRID) / devicePixelRatio;
}

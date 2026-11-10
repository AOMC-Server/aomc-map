/** The 16 Minecraft dye colours, as used by banner icons in /static/markers/<dye>_banner.png. */
export const DYES = [
	"black",
	"blue",
	"brown",
	"cyan",
	"gray",
	"green",
	"light_blue",
	"light_gray",
	"lime",
	"magenta",
	"orange",
	"pink",
	"purple",
	"red",
	"white",
	"yellow",
] as const;

export type Dye = (typeof DYES)[number];

export const DYE_HEX: Record<Dye, string> = {
	black: "#1d1d21",
	blue: "#4952cc",
	brown: "#a55e2a",
	cyan: "#1ccfc0",
	gray: "#747d80",
	green: "#749a1a",
	light_blue: "#3fc3ef",
	light_gray: "#aeaeab",
	lime: "#80c71f",
	magenta: "#d150c6",
	orange: "#f9801d",
	pink: "#ff9bb9",
	purple: "#8932b8",
	red: "#e1372e",
	white: "#eeeeee",
	yellow: "#fed83d",
};

import type { DimensionTheme } from "@aomc/shared/schemas";
import { signal } from "@preact/signals";

/**
 * The look of the interface is three independent choices, each an attribute on <html> that
 * styles.css keys on:
 * - data-mode: dark or light, chosen by the user (or following the system);
 * - data-palette: the colours, from the theme of the dimension being viewed;
 * - data-style: the shapes (corners, borders, bevels, fonts), chosen by the user.
 */

export const STYLES = [
	{
		id: "bedrock",
		name: "Bedrock",
		hint: "Flat, hard edges and a depth edge.",
	},
	{
		id: "win98",
		name: "Windows 98",
		hint: "Grey 3D bevels and gradient title bars.",
	},
	{ id: "xp", name: "Windows XP", hint: "Glossy title bars and soft corners." },
	{
		id: "modern",
		name: "Modern",
		hint: "Rounded, thin borders, soft shadows.",
	},
] as const;

export type StyleId = (typeof STYLES)[number]["id"];

export const MODES = [
	{ id: "system", name: "System" },
	{ id: "dark", name: "Dark" },
	{ id: "light", name: "Light" },
] as const;

export type ModeChoice = (typeof MODES)[number]["id"];
export type Mode = "dark" | "light";

export const DIMENSION_THEME_NAMES: Record<DimensionTheme, string> = {
	overworld: "Overworld",
	nether: "Nether",
	end: "The End",
};

export const isStyle = (value: unknown): value is StyleId =>
	STYLES.some((s) => s.id === value);

export const isModeChoice = (value: unknown): value is ModeChoice =>
	MODES.some((m) => m.id === value);

export const resolveMode = (choice: ModeChoice, prefersLight: boolean): Mode =>
	choice === "system" ? (prefersLight ? "light" : "dark") : choice;

const lightQuery = globalThis.matchMedia?.("(prefers-color-scheme: light)");

/** Whether the system asks for light colours; follows changes. */
export const prefersLight = signal(lightQuery?.matches ?? false);
lightQuery?.addEventListener("change", (e) => {
	prefersLight.value = e.matches;
});

export type Appearance = {
	mode: Mode;
	palette: DimensionTheme;
	style: StyleId;
};

export function applyAppearance(a: Appearance) {
	const root = document.documentElement.dataset;
	root.mode = a.mode;
	root.palette = a.palette;
	root.style = a.style;
}

/**
 * The palette last shown on the map, for the inline script in index.html: it applies the
 * appearance before the first paint, when the map (and so the dimension's theme) is not
 * loaded yet.
 */
export const PALETTE_KEY = "aomc.palette";

export type SavedPalette = { dim: string; palette: DimensionTheme };

export function savePalette(saved: SavedPalette) {
	try {
		globalThis.localStorage?.setItem(PALETTE_KEY, JSON.stringify(saved));
	} catch {}
}

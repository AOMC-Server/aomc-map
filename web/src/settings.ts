import type { View } from "@aomc/shared/view";
import { signal } from "@preact/signals";
import { isModeChoice, isStyle, type ModeChoice, type StyleId } from "./theme";

/** Per-browser preferences, kept in localStorage. */
export type Settings = {
	showCoordinates: boolean;
	showOverworldEquivalent: boolean;
	showScale: boolean;
	rememberPosition: boolean;
	/** Dimension slug to open when the URL names none; null = the first one. */
	defaultDimension: string | null;
	mode: ModeChoice;
	style: StyleId;
	/** Colour the interface after the dimension being viewed, rather than always the overworld. */
	dimensionColours: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
	showCoordinates: true,
	showOverworldEquivalent: true,
	showScale: true,
	rememberPosition: false,
	defaultDimension: null,
	mode: "dark",
	style: "bedrock",
	dimensionColours: true,
};

/** Also read by the inline script in index.html, which sets the theme before first paint. */
const SETTINGS_KEY = "aomc.settings";
const POSITION_KEY = "aomc.position";

/** Reads settings from stored JSON, falling back to the default for anything missing or invalid. */
export function parseSettings(raw: string | null): Settings {
	const result: Settings = { ...DEFAULT_SETTINGS };
	if (!raw) return result;
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return result;
	}
	if (typeof data !== "object" || data === null) return result;
	const stored = data as Record<string, unknown>;
	for (const key of [
		"showCoordinates",
		"showOverworldEquivalent",
		"showScale",
		"rememberPosition",
		"dimensionColours",
	] as const) {
		if (typeof stored[key] === "boolean") result[key] = stored[key];
	}
	if (
		typeof stored.defaultDimension === "string" &&
		stored.defaultDimension !== ""
	) {
		result.defaultDimension = stored.defaultDimension;
	}
	if (isModeChoice(stored.mode)) result.mode = stored.mode;
	if (isStyle(stored.style)) result.style = stored.style;
	return result;
}

export type SavedPosition = { dim: string; view: View };

export function parsePosition(raw: string | null): SavedPosition | null {
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as Partial<SavedPosition> | null;
		const v = p?.view;
		if (
			typeof p?.dim === "string" &&
			p.dim !== "" &&
			v &&
			Number.isFinite(v.centerX) &&
			Number.isFinite(v.centerZ) &&
			Number.isFinite(v.zoom)
		) {
			return {
				dim: p.dim,
				view: { centerX: v.centerX, centerZ: v.centerZ, zoom: v.zoom },
			};
		}
	} catch {}
	return null;
}

function read(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function write(key: string, value: string | null) {
	try {
		if (value === null) globalThis.localStorage?.removeItem(key);
		else globalThis.localStorage?.setItem(key, value);
	} catch {
		// Storage can be unavailable (private mode, full); settings then last for this visit only.
	}
}

export const settings = signal<Settings>(parseSettings(read(SETTINGS_KEY)));

export function updateSettings(patch: Partial<Settings>) {
	settings.value = { ...settings.value, ...patch };
	write(SETTINGS_KEY, JSON.stringify(settings.value));
	if (patch.rememberPosition === false) write(POSITION_KEY, null);
}

export const loadPosition = () => parsePosition(read(POSITION_KEY));

export function savePosition(position: SavedPosition) {
	write(POSITION_KEY, JSON.stringify(position));
}

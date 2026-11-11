import type { View } from "@aomc/shared/view";
import { effect, signal } from "@preact/signals";
import { isModeChoice, isStyle, type ModeChoice, type StyleId } from "./theme";

/** How quickly the camera moves between views; the factor scales how long a transition takes. */
export const TRANSITION_SPEEDS = [
	{ id: "slow", name: "Slow", factor: 2 },
	{ id: "normal", name: "Normal", factor: 1 },
	{ id: "fast", name: "Fast", factor: 0.5 },
	{ id: "instant", name: "Instant", factor: 0 },
] as const;
export type TransitionSpeed = (typeof TRANSITION_SPEEDS)[number]["id"];

export const isTransitionSpeed = (value: unknown): value is TransitionSpeed =>
	TRANSITION_SPEEDS.some((t) => t.id === value);

/** The duration factor for a speed: 1 is normal, 0 skips the animation. */
export const transitionFactor = (speed: TransitionSpeed): number =>
	TRANSITION_SPEEDS.find((t) => t.id === speed)?.factor ?? 1;

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
	/** Camera animations (moving to an upload, zooming): how long they take. */
	transitionSpeed: TransitionSpeed;
	/** History panel: only uploads whose area is in view, rather than all of the dimension's. */
	historyInView: boolean;
	/** History panel: only your own uploads. */
	historyMineOnly: boolean;
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
	transitionSpeed: "normal",
	historyInView: false,
	historyMineOnly: false,
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
		"historyInView",
		"historyMineOnly",
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
	if (isTransitionSpeed(stored.transitionSpeed))
		result.transitionSpeed = stored.transitionSpeed;
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

const PANEL_WIDTH_KEY = "aomc.panelWidth";
export const PANEL_MIN_WIDTH = 320;
export const PANEL_DEFAULT_WIDTH = 400;

/** The widest the side panel may be: most of the window, but always leaving some map. */
export const panelMaxWidth = (windowWidth: number) =>
	Math.max(PANEL_MIN_WIDTH, Math.min(windowWidth - 16, windowWidth * 0.7, 900));

export const clampPanelWidth = (width: number, windowWidth: number) =>
	Math.round(
		Math.min(Math.max(width, PANEL_MIN_WIDTH), panelMaxWidth(windowWidth)),
	);

/** Width in pixels of the right-hand side panel, which can be dragged wider or narrower. */
export const panelWidth = signal<number>(
	(() => {
		const stored = Number(read(PANEL_WIDTH_KEY));
		return Number.isFinite(stored) && stored > 0
			? Math.max(stored, PANEL_MIN_WIDTH)
			: PANEL_DEFAULT_WIDTH;
	})(),
);

export function setPanelWidth(width: number, persist = true) {
	panelWidth.value = clampPanelWidth(width, globalThis.innerWidth ?? 1280);
	if (persist) write(PANEL_WIDTH_KEY, String(panelWidth.value));
}

export function resetPanelWidth() {
	panelWidth.value = PANEL_DEFAULT_WIDTH;
	write(PANEL_WIDTH_KEY, null);
}

// Everything that sits beside the panel (the boss bar, the panel itself) follows this variable.
if (typeof document !== "undefined") {
	effect(() => {
		document.documentElement.style.setProperty(
			"--panel-w",
			`min(${panelWidth.value}px, calc(100vw - 16px))`,
		);
	});
}

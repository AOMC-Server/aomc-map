import type { Dye } from "@aomc/shared/colors";

/**
 * Xaero's Minimap waypoint colours are the 16 chat colours, by index (0 black … 15 white).
 * Each dye gets the closest one.
 */
const XAERO_COLOR: Record<Dye, number> = {
	black: 0,
	blue: 9,
	brown: 4,
	cyan: 3,
	gray: 8,
	green: 2,
	light_blue: 11,
	light_gray: 7,
	lime: 10,
	magenta: 13,
	orange: 6,
	pink: 13,
	purple: 5,
	red: 12,
	white: 15,
	yellow: 14,
};

/** Xaero writes colons in names as "§§", since the fields are separated by colons. */
const escapeName = (s: string) => s.replaceAll(":", "§§");

/** The first letters of the first two words, like "WF" for "Wool farm Portal". */
export function waypointInitials(name: string): string {
	const letters = name
		.split(/\s+/)
		.map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "")
		.filter((c) => c !== "")
		.slice(0, 2)
		.join("")
		.toUpperCase();
	return letters || "X";
}

/**
 * The chat text Xaero's Minimap turns into a clickable waypoint, e.g.
 * "xaero-waypoint:Wool farm:WF:83:~:189:14:false:0:Internal-dim%-1". The height is "~" (unknown):
 * the map only knows x and z.
 */
export function xaeroWaypoint(w: {
	name: string;
	x: number;
	z: number;
	color: Dye;
	/** The dimension's Xaero id, like "dim%-1". */
	dimension: string;
}): string {
	const name = escapeName(w.name.trim()) || "Waypoint";
	return [
		"xaero-waypoint",
		name,
		waypointInitials(w.name),
		w.x,
		"~",
		w.z,
		XAERO_COLOR[w.color],
		"false",
		0,
		`Internal-${w.dimension}`,
	].join(":");
}

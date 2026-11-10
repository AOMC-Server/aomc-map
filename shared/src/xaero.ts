import { MAX_COORD } from "./schemas";

const COORD_RE = /_x(-?\d+)_z(-?\d+)/;

/** Block coordinates of the top-left corner, taken from a Xaero export file name. */
export function parseXaeroCoords(
	filename: string,
): { x: number; z: number } | null {
	const m = COORD_RE.exec(filename);
	if (!m) return null;
	const x = Number(m[1]);
	const z = Number(m[2]);
	if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) return null;
	if (Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD) return null;
	return { x, z };
}

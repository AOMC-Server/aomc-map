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

const EXPORT_DATE_RE = /(\d{4})-(\d{2})-(\d{2})_(\d{2})\.(\d{2})\.(\d{2})/;

/**
 * When an export was made, taken from the `YYYY-MM-DD_HH.MM.SS` that Xaero puts in the name of
 * the export file or folder. Looks at the last path segment first (a file's own name beats its
 * folder's). Read as UTC, so a given name always gives the same time wherever it is parsed.
 * Returns milliseconds since the epoch, or null when no segment carries a valid date.
 */
export function parseXaeroExportDate(path: string): number | null {
	const segments = path.split(/[\\/]/);
	for (let i = segments.length - 1; i >= 0; i--) {
		const m = EXPORT_DATE_RE.exec(segments[i] as string);
		if (!m) continue;
		const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
			number,
			number,
		];
		const ms = Date.UTC(year, month - 1, day, hour, minute, second);
		const d = new Date(ms);
		if (
			year >= 2000 &&
			d.getUTCFullYear() === year &&
			d.getUTCMonth() === month - 1 &&
			d.getUTCDate() === day &&
			hour < 24 &&
			minute < 60 &&
			second < 60
		) {
			return ms;
		}
	}
	return null;
}

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

/** Whether `timeZone` is an IANA time zone name this runtime knows, e.g. "Europe/Berlin". */
export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

/** How far the clock in `timeZone` is ahead of UTC at instant `ms`. */
function zoneOffset(timeZone: string, ms: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(ms);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value);
	const wall = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the clock in `timeZone` shows `wall` (a wall-clock time written as UTC). */
function fromZone(wall: number, timeZone: string): number {
	// The offset may differ on either side of a daylight saving change, so check it again.
	const first = wall - zoneOffset(timeZone, wall);
	return wall - zoneOffset(timeZone, first);
}

/**
 * When an export was made, taken from the `YYYY-MM-DD_HH.MM.SS` that Xaero puts in the name of
 * the export file or folder. Looks at the last path segment first (a file's own name beats its
 * folder's). Xaero writes the local time of the player's computer: `timeZone` (an IANA name)
 * says which zone that was; without it the time is read as UTC.
 * Returns milliseconds since the epoch, or null when no segment carries a valid date.
 */
export function parseXaeroExportDate(
	path: string,
	timeZone?: string,
): number | null {
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
			return timeZone ? fromZone(ms, timeZone) : ms;
		}
	}
	return null;
}

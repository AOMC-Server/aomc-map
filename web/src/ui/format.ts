export function formatTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

/** An export time as written in the file name (it has no time zone), so shown as is. */
export function formatExportTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	});
}

export function formatExportDay(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, {
		dateStyle: "medium",
		timeZone: "UTC",
	});
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatDuration(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

/** When an upload was made: its export time (as written), or else when it was uploaded. */
export function formatEventTime(r: {
	exportedAt: number | null;
	createdAt: number;
}): string {
	return r.exportedAt !== null
		? formatExportTime(r.exportedAt)
		: formatTime(r.createdAt);
}

/** The day an upload was made, as a heading for the upload log. */
export function formatEventDay(r: {
	exportedAt: number | null;
	createdAt: number;
}): string {
	return r.exportedAt !== null
		? formatExportDay(r.exportedAt)
		: new Date(r.createdAt).toLocaleDateString(undefined, {
				dateStyle: "medium",
			});
}

/** "3h", "25m": how long until `ms` from now, roughly. */
export function formatRemaining(ms: number): string {
	const minutes = Math.max(Math.ceil(ms / 60_000), 1);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

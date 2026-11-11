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

/** What a job tells the people waiting for it, in one place so the wording stays consistent. */
export const messages = {
	starting: "Starting",
	upload: {
		reading: "Reading the uploaded images",
		tiles: "Combining the images into map tiles",
		zoom: (level: number) => `Updating zoomed-out tiles (zoom level ${level})`,
		publishing: "Publishing to the map",
	},
	erase: {
		tiles: "Removing the upload from the history of its tiles",
		zoom: (level: number) =>
			`Rebuilding zoomed-out tiles (zoom level ${level})`,
		publishing: "Publishing the changes",
	},
	recompute: {
		tiles: (dimension: string, n: number, of: number) =>
			`Rebuilding ${dimension} in export order (dimension ${n} of ${of})`,
		zoom: (dimension: string, level: number) =>
			`Rebuilding zoomed-out tiles of ${dimension} (zoom level ${level})`,
		publishing: "Publishing the new history",
	},
};

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/**
 * Why a queued job has not started: the history recompute that is running, or the jobs ahead of
 * it. `ahead` are the unfinished jobs queued before it, oldest first.
 */
export function waitingMessage(
	ahead: { type: string; status: string }[],
): string {
	if (ahead.length === 0) return messages.starting;
	const running = ahead.find((j) => j.status === "processing") ?? ahead[0];
	if (running?.type === "recompute_history")
		return "Waiting for the history recompute to finish";
	return `Waiting for ${plural(ahead.length, "job", "jobs")} ahead of it (uploads, deletions and history recomputes run one at a time)`;
}

export function formatTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

export const dyeLabel = (dye: string) => dye.replace("_", " ");

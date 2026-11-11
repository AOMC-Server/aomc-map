import { parseXaeroCoords, parseXaeroExportDate } from "@aomc/shared/xaero";
import type { UploadLimits } from "./state";

export type FileInfo = { name: string; size: number };

export type Validation = {
	/** Problems that make the server reject the upload. */
	errors: string[];
	pngCount: number;
	zipCount: number;
	totalBytes: number;
};

const ext = (name: string) => name.slice(name.lastIndexOf(".")).toLowerCase();

/** Cheap checks before sending: the server validates everything again (images, zip contents). */
export function validateFiles(
	files: FileInfo[],
	limits: Pick<UploadLimits, "maxUploadBytes" | "maxFilesPerUpload">,
): Validation {
	const errors: string[] = [];
	let pngCount = 0;
	let zipCount = 0;
	let totalBytes = 0;

	for (const f of files) {
		totalBytes += f.size;
		const e = ext(f.name);
		if (e === ".png") {
			pngCount++;
			if (!parseXaeroCoords(f.name)) {
				errors.push(
					`${f.name}: no coordinates in the name (expected _x<X>_z<Z>)`,
				);
			}
		} else if (e === ".zip") {
			zipCount++;
		} else {
			errors.push(`${f.name}: only .png and .zip files can be uploaded`);
		}
	}
	if (files.length > limits.maxFilesPerUpload) {
		errors.push(`Too many files (max ${limits.maxFilesPerUpload} per upload)`);
	}
	if (totalBytes > limits.maxUploadBytes) {
		errors.push(
			`Too large: ${formatBytes(totalBytes)} (max ${formatBytes(limits.maxUploadBytes)})`,
		);
	}
	return { errors, pngCount, zipCount, totalBytes };
}

export type ExportDates = {
	/** Distinct export times, oldest first. */
	dates: number[];
	/** PNGs with no date in their name or folder; they count as made when uploaded. */
	undated: number;
};

/** The browser's IANA time zone, which uploads send along; undefined if it cannot tell. */
export function localTimeZone(): string | undefined {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

/** Which exports the files are from. Zips are not counted: their contents are read on the server. */
export function exportDates(
	paths: string[],
	timeZone = localTimeZone(),
): ExportDates {
	const dates = new Set<number>();
	let undated = 0;
	for (const path of paths) {
		if (ext(path) !== ".png") continue;
		const date = parseXaeroExportDate(path, timeZone);
		if (date === null) undated++;
		else dates.add(date);
	}
	return { dates: [...dates].sort((a, b) => a - b), undated };
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

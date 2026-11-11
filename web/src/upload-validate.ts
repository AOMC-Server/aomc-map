import { uploadPathsSchema } from "@aomc/shared/schemas";
import { parseXaeroCoords, parseXaeroExportDate } from "@aomc/shared/xaero";
import type { UploadLimits } from "./state";
import { formatBytes } from "./ui/format";

export type FileInfo = {
	name: string;
	size: number;
	/** Where the file came from (folders included), sent along with it. */
	path?: string;
};

export type Validation = {
	/** Problems that make the server reject the upload. */
	errors: string[];
	pngCount: number;
	zipCount: number;
	totalBytes: number;
};

/** Multipart boundaries, per-file headers and the other form fields, which the server's limit counts too. */
const REQUEST_BASE_BYTES = 1024;
const PART_BYTES = 256;

/** Roughly how many bytes the request carries beyond the files themselves. */
export function requestOverhead(files: FileInfo[]): number {
	const paths = JSON.stringify(files.map((f) => f.path ?? f.name));
	return (
		REQUEST_BASE_BYTES +
		paths.length * 3 +
		files.reduce((n, f) => n + PART_BYTES + f.name.length * 3, 0)
	);
}

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
		if (
			f.path !== undefined &&
			!uploadPathsSchema.element.safeParse(f.path).success
		) {
			errors.push(`${f.name}: the folder path is too long`);
		}
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
		errors.push(
			`Too many files (max ${limits.maxFilesPerUpload} per upload, counting the files inside ZIPs)`,
		);
	}
	// The server limits the whole request, not just the files.
	const requestBytes = totalBytes + requestOverhead(files);
	if (requestBytes > limits.maxUploadBytes) {
		errors.push(
			`Too large: about ${formatBytes(requestBytes)} with overhead (max ${formatBytes(limits.maxUploadBytes)})`,
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

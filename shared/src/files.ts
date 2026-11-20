import * as z from "zod/mini";

/** Longest name of a file or folder in the file library. */
export const MAX_FILE_NAME = 200;
export const MAX_FOLDER_DESCRIPTION = 2000;

/**
 * Why a file or folder name is unusable, or null when it is fine. Names are single path segments:
 * no slashes, no control characters, not "." or "..", and no spaces at either end.
 */
export function fileNameProblem(name: string): string | null {
	if (name.length === 0) return "the name is empty";
	if (name.length > MAX_FILE_NAME)
		return `the name is longer than ${MAX_FILE_NAME} characters`;
	if (name !== name.trim()) return "the name starts or ends with a space";
	if (name === "." || name === "..") return 'the name cannot be "." or ".."';
	if (/[/\\]/.test(name)) return "the name cannot contain / or \\";
	if (/\p{Cc}/u.test(name)) return "the name contains a control character";
	return null;
}

/** The name as stored: Unicode NFC, so names that look the same are the same. */
export const normalizeFileName = (name: string) => name.normalize("NFC");

/** Two names clash when they differ only in case (Windows and macOS would merge them). */
export const fileNameKey = (name: string) =>
	normalizeFileName(name).toLowerCase();

export const fileNameSchema = z.pipe(
	z.pipe(z.string(), z.transform(normalizeFileName)),
	z.string().check(
		z.superRefine((name, ctx) => {
			const problem = fileNameProblem(name);
			if (problem) ctx.addIssue({ code: "custom", message: problem });
		}),
	),
);

/** "world.zip" numbered: "world (2).zip". A leading dot is part of the name, not an extension. */
export function numberedFileName(name: string, n: number): string {
	const dot = name.lastIndexOf(".");
	return dot > 0
		? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
		: `${name} (${n})`;
}

/**
 * What an upload does when the folder already has something of that name:
 * - fail: refuse it (409)
 * - replace: the file gets the new content, and keeps its link and download count
 * - rename: keep both; the new one is numbered, like "world (2).zip"
 */
export const FILE_CONFLICT_MODES = ["fail", "replace", "rename"] as const;
export type FileConflictMode = (typeof FILE_CONFLICT_MODES)[number];

/** A folder path, "/" for the top: names separated by slashes. */
export const filePathSchema = z._default(
	z.string().check(z.maxLength(4000)),
	"/",
);

/** The names in a path such as "/voxy/world 1/"; empty for the top. */
export const splitFilePath = (path: string) =>
	path
		.split("/")
		.filter((s) => s !== "")
		.map(normalizeFileName);

/** The address a file or folder is downloaded or browsed at: /files/<names>, each encoded. */
export function fileUrl(names: readonly string[], folder = false): string {
	const encoded = names.map(encodeURIComponent).join("/");
	return `/files${encoded ? `/${encoded}` : ""}${folder ? "/" : ""}`;
}

export const fileTreeQuerySchema = z.object({ path: filePathSchema });

export const fileUploadQuerySchema = z.object({
	/** The folder to upload into. */
	path: filePathSchema,
	name: fileNameSchema,
	onConflict: z._default(z.enum(FILE_CONFLICT_MODES), "fail"),
});

const descriptionSchema = z
	.string()
	.check(z.trim(), z.maxLength(MAX_FOLDER_DESCRIPTION));

export const createFileFolderSchema = z.object({
	/** null: at the top of the library. */
	parentId: z.nullable(z.int().check(z.positive())),
	name: fileNameSchema,
	description: z._default(descriptionSchema, ""),
});

export const updateFileFolderSchema = z
	.object({
		name: z.optional(fileNameSchema),
		description: z.optional(descriptionSchema),
		/** Move it: null is the top of the library. */
		parentId: z.optional(z.nullable(z.int().check(z.positive()))),
	})
	.check(z.refine((o) => Object.keys(o).length > 0, "nothing to update"));

export const updateFileEntrySchema = z
	.object({
		name: z.optional(fileNameSchema),
		/** Move it: null is the top of the library. */
		folderId: z.optional(z.nullable(z.int().check(z.positive()))),
	})
	.check(z.refine((o) => Object.keys(o).length > 0, "nothing to update"));

export const fileGrantSchema = z.object({
	userId: z.string().check(z.minLength(1)),
});

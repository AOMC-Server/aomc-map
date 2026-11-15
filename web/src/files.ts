import type { FileConflictMode } from "@aomc/shared/files";
import type { InferResponseType } from "hono/client";
import type { api } from "./api";
import { type ErrorBody, failureMessage } from "./errors";

export type FileTree = InferResponseType<typeof api.api.files.tree.$get, 200>;
export type FileItem = FileTree["files"][number];
export type FolderItem = FileTree["folders"][number];

/** The folder names in a /files/… address, decoded; [] for the top of the library. */
export function namesFromLocation(pathname: string): string[] {
	try {
		return pathname
			.replace(/^\/files\/?/, "")
			.split("/")
			.filter((s) => s !== "")
			.map(decodeURIComponent);
	} catch {
		return [];
	}
}

export const pathOfNames = (names: readonly string[]) => `/${names.join("/")}`;

export type PutOutcome =
	| { ok: true; file: FileItem }
	| { ok: false; conflict: "file" | "folder" | null; error: string };

/** Uploads one file into the folder with progress; resolves with what the server said. */
export function putFile(
	folderPath: string,
	file: File,
	onConflict: FileConflictMode,
	onProgress: (loaded: number) => void,
	signal?: AbortSignal,
): Promise<PutOutcome> {
	return new Promise((resolve) => {
		const query = new URLSearchParams({
			path: folderPath,
			name: file.name,
			onConflict,
		});
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", `/api/files/upload?${query}`);
		xhr.setRequestHeader("Content-Type", "application/octet-stream");
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onerror = () =>
			resolve({
				ok: false,
				conflict: null,
				error: "Network error while uploading.",
			});
		xhr.onabort = () =>
			resolve({ ok: false, conflict: null, error: "Cancelled." });
		xhr.onload = () => {
			let body:
				| (ErrorBody & { file?: FileItem; conflict?: "file" | "folder" })
				| null = null;
			try {
				body = JSON.parse(xhr.responseText);
			} catch {}
			if (xhr.status === 201 && body?.file) {
				resolve({ ok: true, file: body.file });
				return;
			}
			resolve({
				ok: false,
				conflict: xhr.status === 409 ? (body?.conflict ?? null) : null,
				error:
					xhr.status === 413
						? "The file is larger than the server allows."
						: xhr.status === 507
							? "The file library is full."
							: failureMessage(xhr.status, body),
			});
		};
		signal?.addEventListener("abort", () => xhr.abort());
		xhr.send(file);
	});
}

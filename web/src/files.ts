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

/**
 * Upload speed from progress reports, smoothed over the last few seconds (`smoothingMs`) so
 * estimates don't jump around with every burst.
 */
export function createSpeedMeter(smoothingMs = 3000) {
	let start: number | null = null;
	let last: { at: number; bytes: number } | null = null;
	let speed: number | null = null;
	return {
		sample(bytes: number, now = performance.now()) {
			if (!last) {
				start = now;
				last = { at: now, bytes };
				return;
			}
			const dt = now - last.at;
			if (dt < 250) return;
			const current = ((bytes - last.bytes) / dt) * 1000;
			speed =
				speed === null
					? current
					: speed + (1 - Math.exp(-dt / smoothingMs)) * (current - speed);
			last = { at: now, bytes };
		},
		/**
		 * Bytes per second; null for the first second, when it would be a guess. While no
		 * progress is reported the speed falls, so a stalled upload's estimate grows.
		 */
		speed(now = performance.now()): number | null {
			if (speed === null || start === null || !last || now - start < 1000)
				return null;
			const quiet = now - last.at;
			return quiet > 1000 ? speed * Math.exp(-quiet / smoothingMs) : speed;
		},
	};
}

export type SpeedMeter = ReturnType<typeof createSpeedMeter>;

/** Seconds until `remaining` bytes are sent at `speed`, or null when that can't be told. */
export const secondsLeft = (remaining: number, speed: number | null) =>
	speed && speed > 0 ? remaining / speed : null;

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

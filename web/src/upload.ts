import { signal } from "@preact/signals";
import { mapView, refreshHead } from "./controller";
import { showNotice } from "./layers";
import type { Bounds } from "./map/geometry";
import { fetchRevision, loadRevisions, watchRevision } from "./revisions";

export type UploadState =
	| { phase: "idle" }
	| { phase: "uploading"; percent: number; fileCount: number }
	| {
			phase: "processing";
			revisionId: number;
			message: string;
			done?: number;
			total?: number;
	  }
	| {
			phase: "done";
			revisionId: number;
			rev: number | null;
			bbox: Bounds | null;
	  }
	| {
			phase: "failed";
			error: string;
			fileErrors: { file: string; error: string }[];
	  };

export const uploadOpen = signal(false);
export const uploadState = signal<UploadState>({ phase: "idle" });

export function resetUpload() {
	if (
		uploadState.value.phase !== "uploading" &&
		uploadState.value.phase !== "processing"
	) {
		uploadState.value = { phase: "idle" };
	}
}

export const uploadBusy = () =>
	uploadState.value.phase === "uploading" ||
	uploadState.value.phase === "processing";

type ErrorBody = { error?: string; errors?: { file: string; error: string }[] };

/** Sends the files to the server (with upload progress), then follows the processing job. */
export function startUpload(mapSlug: string, dimSlug: string, files: File[]) {
	if (uploadBusy()) return;
	const form = new FormData();
	for (const f of files) form.append("files[]", f, f.name);

	uploadState.value = {
		phase: "uploading",
		percent: 0,
		fileCount: files.length,
	};
	const xhr = new XMLHttpRequest();
	xhr.open(
		"POST",
		`/api/maps/${encodeURIComponent(mapSlug)}/dimensions/${encodeURIComponent(dimSlug)}/uploads`,
	);
	xhr.upload.onprogress = (e) => {
		if (e.lengthComputable && uploadState.value.phase === "uploading") {
			uploadState.value = {
				phase: "uploading",
				percent: (e.loaded / e.total) * 100,
				fileCount: files.length,
			};
		}
	};
	xhr.onerror = () => {
		uploadState.value = {
			phase: "failed",
			error: "Network error while uploading.",
			fileErrors: [],
		};
	};
	xhr.onload = () => {
		let body: (ErrorBody & { revisionId?: number }) | null = null;
		try {
			body = JSON.parse(xhr.responseText);
		} catch {}
		if (xhr.status === 202 && body?.revisionId) {
			void follow(body.revisionId);
			return;
		}
		const reason =
			xhr.status === 401
				? "You need to log in to upload."
				: (body?.error ?? `Upload failed (${xhr.status}).`);
		uploadState.value = {
			phase: "failed",
			error: reason,
			fileErrors: body?.errors ?? [],
		};
	};
	xhr.send(form);
}

async function follow(revisionId: number) {
	uploadState.value = { phase: "processing", revisionId, message: "Queued" };
	void loadRevisions();
	const outcome = await watchRevision(revisionId, (p) => {
		uploadState.value = {
			phase: "processing",
			revisionId,
			message: p.message ?? "Processing",
			done: p.done,
			total: p.total,
		};
	});

	if (outcome.status === "failed") {
		const message = outcome.error || "Processing failed.";
		uploadState.value = { phase: "failed", error: message, fileErrors: [] };
		showNotice(`Upload failed: ${message}`, "error");
		void loadRevisions();
		return;
	}
	const revision = await fetchRevision(revisionId);
	uploadState.value = {
		phase: "done",
		revisionId,
		rev: revision?.rev ?? null,
		bbox: revision?.bbox ?? null,
	};
	showNotice("Upload finished. The map has been updated.");
	await refreshHead();
	void loadRevisions();
}

/** Zooms the map to the area covered by a finished upload. */
export function showUploadOnMap(bbox: Bounds) {
	mapView.value?.fitBounds(bbox, { padding: 100, closestZoom: 0 });
	uploadOpen.value = false;
}

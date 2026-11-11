import { signal } from "@preact/signals";
import { showNotice } from "./api";
import { mapView, refreshMap, selectDimension } from "./controller";
import type { Bounds } from "./map/geometry";
import { fetchRevision, loadRevisions, watchRevision } from "./revisions";
import { currentMap } from "./state";
import type { UploadItem } from "./upload-files";

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
			dimSlug: string | null;
			/** Exports that were added to the map, and how many of them could not be. */
			exports: number;
			failed: number;
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
export function startUpload(dimSlug: string, items: UploadItem[]) {
	if (uploadBusy()) return;
	const files = items.map((i) => i.file);
	const form = new FormData();
	for (const f of files) form.append("files[]", f, f.name);
	form.append("paths", JSON.stringify(items.map((i) => i.path)));

	uploadState.value = {
		phase: "uploading",
		percent: 0,
		fileCount: files.length,
	};
	const xhr = new XMLHttpRequest();
	xhr.open("POST", `/api/dimensions/${encodeURIComponent(dimSlug)}/uploads`);
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
		let body: (ErrorBody & { revisionIds?: number[] }) | null = null;
		try {
			body = JSON.parse(xhr.responseText);
		} catch {}
		if (xhr.status === 202 && body?.revisionIds?.length) {
			void follow(body.revisionIds);
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

/** The area covered by all of them. */
function union(boxes: Bounds[]): Bounds | null {
	const [first, ...rest] = boxes;
	if (!first) return null;
	return rest.reduce(
		(a, b) => ({
			minX: Math.min(a.minX, b.minX),
			minZ: Math.min(a.minZ, b.minZ),
			maxX: Math.max(a.maxX, b.maxX),
			maxZ: Math.max(a.maxZ, b.maxZ),
		}),
		first,
	);
}

/** An upload makes one revision per export; they are processed in order, so follow them in order. */
async function follow(revisionIds: number[]) {
	const last = revisionIds.at(-1) as number;
	uploadState.value = {
		phase: "processing",
		revisionId: revisionIds[0] as number,
		message: "Queued",
	};
	void loadRevisions();

	const succeeded: number[] = [];
	let firstError: string | null = null;
	for (const [i, id] of revisionIds.entries()) {
		const prefix =
			revisionIds.length > 1
				? `Export ${i + 1} of ${revisionIds.length}: `
				: "";
		const outcome = await watchRevision(id, (p) => {
			uploadState.value = {
				phase: "processing",
				revisionId: id,
				message: prefix + (p.message ?? "Processing"),
				done: p.done,
				total: p.total,
			};
		});
		if (outcome.status === "failed") {
			firstError ??= outcome.error || "Processing failed.";
		} else {
			succeeded.push(id);
		}
	}

	if (succeeded.length === 0) {
		const message = firstError ?? "Processing failed.";
		uploadState.value = { phase: "failed", error: message, fileErrors: [] };
		showNotice(`Upload failed: ${message}`, "error");
		void loadRevisions();
		return;
	}
	const revisions = (await Promise.all(succeeded.map(fetchRevision))).filter(
		(r) => r !== null,
	);
	const lastDone = revisions.at(-1);
	uploadState.value = {
		phase: "done",
		revisionId: succeeded.at(-1) ?? last,
		rev: lastDone?.rev ?? null,
		bbox: union(revisions.flatMap((r) => (r.bbox ? [r.bbox] : []))),
		dimSlug:
			currentMap.value?.dimensions.find((d) => d.id === lastDone?.dimensionId)
				?.slug ?? null,
		exports: succeeded.length,
		failed: revisionIds.length - succeeded.length,
	};
	if (firstError) {
		showNotice(`Some exports failed: ${firstError}`, "error");
	} else {
		showNotice("Upload finished. The map has been updated.");
	}
	await refreshMap();
	void loadRevisions();
}

/** Zooms the map to the area covered by a finished upload. */
export function showUploadOnMap(bbox: Bounds, dimSlug: string | null) {
	if (dimSlug) selectDimension(dimSlug);
	mapView.value?.fitBounds(bbox, { padding: 100, closestZoom: 0 });
	uploadOpen.value = false;
}

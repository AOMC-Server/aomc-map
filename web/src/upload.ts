import { signal } from "@preact/signals";
import { mapView, refreshHead } from "./controller";
import { showNotice } from "./layers";
import type { Bounds } from "./map/geometry";

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
			follow(body.revisionId);
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

type RevisionBody = {
	revision: {
		status: "pending" | "processing" | "done" | "failed";
		rev: number | null;
		error: string | null;
		bbox: Bounds | null;
	};
};

async function fetchRevision(
	id: number,
): Promise<RevisionBody["revision"] | null> {
	try {
		const res = await fetch(`/api/revisions/${id}`);
		return res.ok ? ((await res.json()) as RevisionBody).revision : null;
	} catch {
		return null;
	}
}

async function finish(
	id: number,
	status: "done" | "failed",
	error?: string | null,
) {
	if (status === "failed") {
		const message = error || "Processing failed.";
		uploadState.value = { phase: "failed", error: message, fileErrors: [] };
		showNotice(`Upload failed: ${message}`, "error");
		return;
	}
	const revision = await fetchRevision(id);
	uploadState.value = {
		phase: "done",
		revisionId: id,
		rev: revision?.rev ?? null,
		bbox: revision?.bbox ?? null,
	};
	showNotice("Upload finished. The map has been updated.");
	await refreshHead();
}

/** Follows a revision with server-sent events, falling back to polling if the stream breaks. */
function follow(revisionId: number) {
	uploadState.value = { phase: "processing", revisionId, message: "Queued" };
	let settled = false;
	const settle = (status: "done" | "failed", error?: string | null) => {
		if (settled) return;
		settled = true;
		void finish(revisionId, status, error);
	};

	const poll = async () => {
		while (!settled) {
			const r = await fetchRevision(revisionId);
			if (r?.status === "done") return settle("done");
			if (r?.status === "failed") return settle("failed", r.error);
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	};

	if (typeof EventSource === "undefined") {
		void poll();
		return;
	}
	const source = new EventSource(`/api/revisions/${revisionId}/events`);
	const onProgress = (e: MessageEvent) => {
		const d = JSON.parse(e.data) as {
			message?: string;
			done?: number;
			total?: number;
		};
		if (settled) return;
		uploadState.value = {
			phase: "processing",
			revisionId,
			message: d.message ?? "Processing",
			done: d.done,
			total: d.total,
		};
	};
	source.addEventListener("pending", onProgress);
	source.addEventListener("processing", onProgress);
	source.addEventListener("done", () => {
		source.close();
		settle("done");
	});
	source.addEventListener("failed", (e) => {
		source.close();
		settle(
			"failed",
			(JSON.parse((e as MessageEvent).data) as { error?: string }).error,
		);
	});
	source.onerror = () => {
		if (settled) return;
		source.close();
		void poll();
	};
}

/** Zooms the map to the area covered by a finished upload. */
export function showUploadOnMap(bbox: Bounds) {
	mapView.value?.fitBounds(bbox, { padding: 100, closestZoom: 0 });
	uploadOpen.value = false;
}

import { signal } from "@preact/signals";
import { mapView } from "../controller";
import { deleteUpload } from "../revisions";
import { highlightBbox, type RevisionInfo, user } from "../state";
import { formatExportTime, formatTime } from "./format";
import { Modal } from "./Modal";

/** The upload whose delete is being confirmed. */
export const deleteUploadFor = signal<RevisionInfo | null>(null);

const close = () => {
	deleteUploadFor.value = null;
	highlightBbox.value = null;
};

/** Asks before deleting an upload for good, with what it is and where. */
export function DeleteUploadDialog() {
	const r = deleteUploadFor.value;
	if (!r) return null;
	const failed = r.status === "failed";
	const own = r.authorId === user.value?.id;
	const box = r.bbox;

	return (
		<Modal title="Delete upload" onClose={close}>
			<dl class="delete-facts">
				<dt>By</dt>
				<dd>{own ? `${r.authorName} (you)` : r.authorName}</dd>
				{r.exportedAt !== null && (
					<>
						<dt>Exported</dt>
						<dd>{formatExportTime(r.exportedAt)}</dd>
					</>
				)}
				<dt>Uploaded</dt>
				<dd>{formatTime(r.createdAt)}</dd>
				<dt>Files</dt>
				<dd>{r.fileCount}</dd>
				{box && (
					<>
						<dt>Area</dt>
						<dd>
							{box.maxX - box.minX + 1} × {box.maxZ - box.minZ + 1} blocks, from{" "}
							{box.minX}, {box.minZ}
						</dd>
					</>
				)}
				{r.rev !== null && (
					<>
						<dt>Revision</dt>
						<dd>#{r.rev}</dd>
					</>
				)}
			</dl>
			<p class={failed ? "muted" : "warn-text"}>
				{failed
					? "It only failed to process, so there is nothing to undo on the map."
					: "It is removed from the map and from every past revision, and cannot be restored. To bring it back, upload the files again."}
			</p>
			<div class="modal-actions">
				<button
					type="button"
					class="btn danger"
					onClick={() => {
						close();
						void deleteUpload(r.id);
					}}
				>
					Delete permanently
				</button>
				{box && (
					<button
						type="button"
						class="btn"
						onClick={() => {
							highlightBbox.value = box;
							mapView.value?.fitBounds(box, { padding: 120, closestZoom: 0 });
						}}
					>
						Show area
					</button>
				)}
				<span class="spacer" />
				<button type="button" class="btn" onClick={close}>
					Cancel
				</button>
			</div>
		</Modal>
	);
}

import { canEdit } from "@aomc/shared/roles";
import { useEffect, useState } from "preact/hooks";
import { loginUrl } from "../api";
import {
	currentMap,
	dimSlug,
	readOnly,
	user,
	visibleDimensions,
} from "../state";
import {
	resetUpload,
	showUploadOnMap,
	startUpload,
	uploadOpen,
	uploadState,
} from "../upload";
import {
	fromDrop,
	fromFileList,
	itemKey,
	type UploadItem,
} from "../upload-files";
import { exportDates, validateFiles } from "../upload-validate";
import { formatBytes, formatDay } from "./format";
import { Modal } from "./Modal";

function ProgressBar(props: { percent?: number; label: string }) {
	const p = props.percent;
	return (
		<div class="progress-wrap">
			<div
				class="progress"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={p === undefined ? undefined : Math.round(p)}
			>
				<div
					class={`bar ${p === undefined ? "indeterminate" : ""}`}
					style={p === undefined ? undefined : { width: `${p}%` }}
				/>
			</div>
			<div class="muted">{props.label}</div>
		</div>
	);
}

/** Upload of Xaero's World Map exports (PNG or ZIP) into the current map and dimension. */
export function UploadDialog() {
	const [files, setFiles] = useState<UploadItem[]>([]);
	const [dragging, setDragging] = useState(false);
	const [dim, setDim] = useState(dimSlug.value ?? "");

	const detail = currentMap.value;
	const state = uploadState.value;
	const dims = visibleDimensions.value;

	useEffect(() => {
		if (dimSlug.value) setDim(dimSlug.value);
	}, [dimSlug.value]);

	if (!detail) return null;
	const canUpload = canEdit(detail.role);
	const validation = validateFiles(
		files.map((i) => ({
			name: i.file.name,
			size: i.file.size,
			path: i.path,
		})),
		detail.limits,
	);
	const dates = exportDates(files.map((i) => i.path));
	const dimName = dims.find((d) => d.slug === dim)?.name ?? dim;

	const addFiles = (incoming: UploadItem[]) => {
		setFiles((prev) => {
			const seen = new Set(prev.map(itemKey));
			return [...prev, ...incoming.filter((i) => !seen.has(itemKey(i)))];
		});
	};

	const close = () => {
		uploadOpen.value = false;
	};

	return (
		<Modal title="Upload map data" onClose={close}>
			{state.phase === "idle" && (
				<>
					<ol class="steps">
						<li>
							<b>Turn off resource packs</b> if you have any enabled.
						</li>
						<li>
							In Xaero's World Map, drag with the right mouse button over the
							area and choose to export it as PNG.
						</li>
						<li>
							Set <b>Multiple Unscaled Images</b> to ON, then confirm.
						</li>
						<li>
							Select the exported images (or a ZIP of them). They are usually
							saved in <code>.minecraft/your_instance_folder/map exports/</code>
						</li>
					</ol>

					{!user.value ? (
						<p>
							<a class="btn primary" href={loginUrl()}>
								Log in with Discord
							</a>{" "}
							to upload.
						</p>
					) : readOnly.value ? (
						<p class="muted">
							The map is in maintenance, so uploads are paused. Try again once
							it is over.
						</p>
					) : !canUpload ? (
						<p class="muted">
							You have view-only access to this map, so you can't upload to it.
						</p>
					) : (
						<>
							<div class="upload-target">
								Uploading to <b>{detail.map.name}</b>, dimension{" "}
								<select
									value={dim}
									aria-label="Dimension"
									onChange={(e) => setDim(e.currentTarget.value)}
								>
									{dims.map((d) => (
										<option key={d.slug} value={d.slug}>
											{d.name}
										</option>
									))}
								</select>
							</div>

							<label
								class={`dropzone ${dragging ? "dragging" : ""}`}
								onDragOver={(e) => {
									e.preventDefault();
									setDragging(true);
								}}
								onDragLeave={() => setDragging(false)}
								onDrop={(e) => {
									e.preventDefault();
									setDragging(false);
									if (e.dataTransfer)
										void fromDrop(e.dataTransfer).then(addFiles);
								}}
							>
								<input
									type="file"
									multiple
									accept=".png,.zip,image/png,application/zip"
									hidden
									onChange={(e) => {
										if (e.currentTarget.files)
											addFiles(fromFileList(e.currentTarget.files));
										e.currentTarget.value = "";
									}}
								/>
								<span>
									Drop PNG or ZIP files, or whole export folders, here, or click
									to choose files
								</span>
							</label>
							<label class="btn folder-pick">
								<input
									type="file"
									multiple
									// @ts-expect-error non-standard attribute, supported by every major browser
									webkitdirectory=""
									hidden
									onChange={(e) => {
										if (e.currentTarget.files)
											addFiles(fromFileList(e.currentTarget.files));
										e.currentTarget.value = "";
									}}
								/>
								Choose a folder…
							</label>
							<p class="muted hint">
								Exports are layered by the date in their file or folder name
								(like <code>2026-02-10_15.06.41</code>), newest on top, so
								importing old exports never covers newer data.
							</p>

							{files.length > 0 && (
								<div class="file-summary">
									<div>
										<b>{files.length}</b> file{files.length === 1 ? "" : "s"},{" "}
										{formatBytes(validation.totalBytes)}
										<button
											type="button"
											class="plain link"
											onClick={() => setFiles([])}
										>
											clear
										</button>
									</div>
									{dates.dates.length > 0 && (
										<div class="muted">
											{dates.dates.length} export
											{dates.dates.length === 1 ? "" : "s"} made{" "}
											{formatDay(dates.dates[0] as number)}
											{dates.dates.length > 1 &&
												` to ${formatDay(dates.dates.at(-1) as number)}`}
										</div>
									)}
									{dates.undated > 0 && (
										<div class="muted">
											{dates.undated} file
											{dates.undated === 1 ? " has" : "s have"} no date in the
											name or folder and will count as made now.
										</div>
									)}
									<ul class="file-list">
										{files.slice(0, 6).map((f) => (
											<li key={itemKey(f)}>{f.path}</li>
										))}
										{files.length > 6 && (
											<li class="muted">…and {files.length - 6} more</li>
										)}
									</ul>
									{validation.errors.length > 0 && (
										<ul class="errors">
											{validation.errors.slice(0, 5).map((e) => (
												<li key={e}>{e}</li>
											))}
											{validation.errors.length > 5 && (
												<li>
													…and {validation.errors.length - 5} more problems
												</li>
											)}
										</ul>
									)}
								</div>
							)}

							<div class="modal-actions">
								<button
									type="button"
									class="btn primary"
									disabled={
										files.length === 0 || validation.errors.length > 0 || !dim
									}
									onClick={() => startUpload(dim, files)}
								>
									{files.length === 0
										? "Upload"
										: `Upload ${files.length} file${files.length === 1 ? "" : "s"} to ${dimName}`}
								</button>
							</div>
						</>
					)}
				</>
			)}

			{state.phase === "uploading" && (
				<ProgressBar
					percent={state.percent}
					label={`Uploading ${state.fileCount} file${state.fileCount === 1 ? "" : "s"}… ${Math.round(state.percent)}%`}
				/>
			)}

			{state.phase === "processing" && (
				<>
					<ProgressBar
						percent={
							state.total ? ((state.done ?? 0) / state.total) * 100 : undefined
						}
						label={`${state.message}${state.total ? ` (${state.done ?? 0}/${state.total})` : "…"}`}
					/>
					<p class="muted">
						You can close this window; processing continues in the background.
					</p>
				</>
			)}

			{state.phase === "done" && (
				<>
					<p class="success">
						{state.exports > 1
							? `${state.exports} exports added`
							: "Upload finished"}
						{state.rev !== null && state.exports === 1
							? ` as revision ${state.rev}`
							: ""}
						.
					</p>
					{state.failed > 0 && (
						<p class="error-text">
							{state.failed} export{state.failed === 1 ? "" : "s"} failed; see
							the history panel.
						</p>
					)}
					<div class="modal-actions">
						{state.bbox && (
							<button
								type="button"
								class="btn primary"
								onClick={() =>
									state.bbox && showUploadOnMap(state.bbox, state.dimSlug)
								}
							>
								Show on map
							</button>
						)}
						<button
							type="button"
							class="btn"
							onClick={() => {
								setFiles([]);
								resetUpload();
							}}
						>
							Upload more
						</button>
					</div>
				</>
			)}

			{state.phase === "failed" && (
				<>
					<p class="error-text">{state.error}</p>
					{state.fileErrors.length > 0 && (
						<ul class="errors">
							{state.fileErrors.slice(0, 8).map((e) => (
								<li key={`${e.file}:${e.error}`}>
									<b>{e.file}</b>: {e.error}
								</li>
							))}
							{state.fileErrors.length > 8 && (
								<li>…and {state.fileErrors.length - 8} more</li>
							)}
						</ul>
					)}
					<div class="modal-actions">
						<button type="button" class="btn" onClick={resetUpload}>
							Try again
						</button>
					</div>
				</>
			)}
		</Modal>
	);
}

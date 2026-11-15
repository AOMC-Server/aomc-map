import { type FileConflictMode, fileNameKey } from "@aomc/shared/files";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, loginUrl, ok, showNotice } from "../api";
import {
	type FileItem,
	type FileTree,
	type FolderItem,
	namesFromLocation,
	pathOfNames,
	putFile,
} from "../files";
import { user } from "../state";
import { formatBytes, formatTime } from "./format";
import { PixelIcon } from "./icons";
import { Modal } from "./Modal";
import { LoadFailed, Page, usePageLoad } from "./Page";
import { PopupText } from "./PopupText";

type Go = (url: string) => void;

/** A link inside the library: followed without reloading the page, unless opened elsewhere. */
function FolderLink(props: {
	href: string;
	go: Go;
	class?: string;
	children: ComponentChildren;
}) {
	return (
		<a
			href={props.href}
			class={props.class}
			onClick={(e) => {
				if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
					return;
				e.preventDefault();
				props.go(props.href);
			}}
		>
			{props.children}
		</a>
	);
}

/** /files/<folders>/: browse the file library, and change it where you may. */
export function FilesPage() {
	const { status, retry } = usePageLoad();
	const [names, setNames] = useState(() =>
		namesFromLocation(location.pathname),
	);
	useEffect(() => {
		const onPop = () => setNames(namesFromLocation(location.pathname));
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);
	const go: Go = (url) => {
		history.pushState(null, "", url);
		setNames(namesFromLocation(new URL(url, location.href).pathname));
	};

	return (
		<Page title="Files">
			{status === "loading" ? (
				<p class="muted">Loading…</p>
			) : status === "failed" ? (
				<LoadFailed retry={retry} />
			) : !user.value ? (
				<section class="page-section">
					<h2>Files</h2>
					<p class="muted">
						Downloads such as Voxy data and Xaero presets. Log in to browse and
						download them.
					</p>
					<a class="btn primary" href={loginUrl()}>
						Log in with Discord
					</a>
				</section>
			) : (
				<Library names={names} go={go} />
			)}
		</Page>
	);
}

type Target =
	| { type: "folder"; item: FolderItem }
	| { type: "file"; item: FileItem };

type ConflictChoice = { mode: FileConflictMode | "skip"; forAll: boolean };

type Dialog =
	| { kind: "newFolder" }
	| { kind: "describe" }
	| { kind: "access" }
	| { kind: "rename"; target: Target }
	| { kind: "move"; target: Target }
	| {
			kind: "conflict";
			name: string;
			folder: boolean;
			answer: (choice: ConflictChoice) => void;
	  };

type Job = {
	key: number;
	file: File;
	/** The folder it goes to, as a path. */
	folder: string;
	mode: FileConflictMode;
	loaded: number;
	state: "waiting" | "uploading" | "done" | "failed" | "skipped";
	error?: string;
};

let nextJobKey = 1;

function Library(props: { names: string[]; go: Go }) {
	const { names, go } = props;
	const path = pathOfNames(names);
	const [tree, setTree] = useState<FileTree | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [missing, setMissing] = useState(false);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [dragging, setDragging] = useState(false);
	const pick = useRef<HTMLInputElement>(null);
	const replacePick = useRef<HTMLInputElement>(null);
	const replacing = useRef<FileItem | null>(null);
	const currentPath = useRef(path);
	currentPath.current = path;
	const shown = useRef(tree);
	shown.current = tree;

	/** What already has the job's name, as far as the listing on screen knows. */
	const knownClash = (job: Job): "file" | "folder" | null => {
		const t = shown.current;
		if (!t || t.path !== job.folder) return null;
		const key = fileNameKey(job.file.name);
		if (t.folders.some((f) => fileNameKey(f.name) === key)) return "folder";
		if (t.files.some((f) => fileNameKey(f.name) === key)) return "file";
		return null;
	};

	const load = async (forPath = path) => {
		const r = await attempt(() =>
			api.api.files.tree.$get({ query: { path: forPath } }),
		);
		if (forPath !== currentPath.current) return;
		if (r.ok) {
			setTree(r.body);
			setMissing(false);
			setError(null);
		} else if (r.status === 404) {
			setMissing(true);
			setTree(null);
		} else setError(r.error);
	};
	const openDialog = useRef(dialog);
	openDialog.current = dialog;
	useEffect(() => {
		// A question about an upload can't wait for a folder that is no longer shown.
		const d = openDialog.current;
		if (d?.kind === "conflict") d.answer({ mode: "skip", forAll: false });
		setTree(null);
		setMissing(false);
		setDialog(null);
		void load(path);
	}, [path]);

	// Uploads, one at a time, in the order they were picked.
	const jobs = useRef<Job[]>([]);
	const [, rerender] = useState(0);
	const refresh = () => rerender((n) => n + 1);
	const running = useRef(false);
	const abort = useRef<AbortController | null>(null);

	useEffect(() => {
		const warn = (e: BeforeUnloadEvent) => {
			if (running.current) e.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, []);

	const ask = (name: string, folder: boolean) =>
		new Promise<ConflictChoice>((answer) =>
			setDialog({ kind: "conflict", name, folder, answer }),
		);

	async function pump() {
		if (running.current) return;
		running.current = true;
		let remembered: ConflictChoice["mode"] | null = null;
		try {
			for (;;) {
				const job = jobs.current.find((j) => j.state === "waiting");
				if (!job) break;
				job.state = "uploading";
				refresh();
				abort.current = new AbortController();
				let mode = job.mode;
				for (;;) {
					job.loaded = 0;
					// Ask before sending what the server would refuse, rather than after a long upload.
					const clash = mode === "fail" ? knownClash(job) : null;
					const signal = abort.current.signal;
					const result = clash
						? ({ ok: false, conflict: clash, error: "" } as const)
						: await putFile(
								job.folder,
								job.file,
								mode,
								(loaded) => {
									job.loaded = loaded;
									refresh();
								},
								signal,
							);
					if (result.ok) {
						job.state = "done";
						if (job.folder === currentPath.current) void load();
						break;
					}
					if (result.conflict && mode === "fail") {
						const folder = result.conflict === "folder";
						let choice = remembered;
						if (!choice || (folder && choice === "replace")) {
							const answer = await ask(job.file.name, folder);
							setDialog(null);
							choice = answer.mode;
							if (answer.forAll) remembered = answer.mode;
						}
						if (choice === "skip") {
							job.state = "skipped";
							break;
						}
						mode = choice;
						continue;
					}
					job.state = "failed";
					job.error = result.error;
					break;
				}
				refresh();
			}
		} finally {
			running.current = false;
			abort.current = null;
			refresh();
		}
	}

	const enqueue = (files: File[], mode: FileConflictMode = "fail") => {
		const max = tree?.limits.maxFileBytes ?? Number.POSITIVE_INFINITY;
		for (const file of files) {
			const tooBig = file.size > max;
			jobs.current.push({
				key: nextJobKey++,
				file,
				folder: path,
				mode,
				loaded: 0,
				state: tooBig ? "failed" : "waiting",
				error: tooBig
					? `Larger than the ${formatBytes(max)} a file may be.`
					: undefined,
			});
		}
		refresh();
		void pump();
	};

	const cancelUploads = () => {
		for (const j of jobs.current)
			if (j.state === "waiting") {
				j.state = "skipped";
			}
		abort.current?.abort();
		refresh();
	};

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		const items = [...(e.dataTransfer?.items ?? [])].filter(
			(i) => i.kind === "file",
		);
		const isFolder = (i: DataTransferItem) =>
			i.webkitGetAsEntry?.()?.isDirectory === true;
		if (items.some(isFolder))
			showNotice(
				"Folders can't be uploaded. Put them in a ZIP file and upload that.",
				"error",
			);
		const files = items
			.filter((i) => !isFolder(i))
			.map((i) => i.getAsFile())
			.filter((f): f is File => f !== null);
		if (files.length > 0) enqueue(files);
	};

	// Files dropped on the listing are uploaded into the folder, where you may.
	const listing = useRef<HTMLElement>(null);
	const dropped = useRef(onDrop);
	dropped.current = onDrop;
	const canDrop = tree?.canWrite ?? false;
	useEffect(() => {
		const el = listing.current;
		if (!el || !canDrop) return;
		const over = (e: DragEvent) => {
			e.preventDefault();
			setDragging(true);
		};
		const leave = (e: DragEvent) => {
			if (!el.contains(e.relatedTarget as Node | null)) setDragging(false);
		};
		const drop = (e: DragEvent) => dropped.current(e);
		el.addEventListener("dragover", over);
		el.addEventListener("dragleave", leave);
		el.addEventListener("drop", drop);
		return () => {
			el.removeEventListener("dragover", over);
			el.removeEventListener("dragleave", leave);
			el.removeEventListener("drop", drop);
		};
	}, [canDrop, tree !== null]);

	if (missing)
		return (
			<section class="page-section">
				<h2>Not found</h2>
				<p class="muted">There is no folder at {path}.</p>
				<FolderLink class="btn" href="/files/" go={go}>
					Go to the top
				</FolderLink>
			</section>
		);
	if (!tree)
		return error ? (
			<p class="error-text">Could not load the folder: {error}</p>
		) : (
			<p class="muted">Loading…</p>
		);

	const write = tree.canWrite;
	const empty = tree.folders.length === 0 && tree.files.length === 0;
	const uploadsShown = jobs.current.length > 0;

	return (
		<>
			<section class="page-section">
				<nav class="file-crumbs" aria-label="Folders">
					<FolderLink href="/files/" go={go}>
						Files
					</FolderLink>
					{tree.breadcrumbs.map((b) => (
						<span key={b.id}>
							<span class="sep" aria-hidden="true">
								/
							</span>
							<FolderLink href={b.url} go={go}>
								{b.name}
							</FolderLink>
						</span>
					))}
				</nav>
				{tree.folder?.description ? (
					<div class="file-description">
						<PopupText text={tree.folder.description} />
					</div>
				) : (
					!tree.folder && (
						<p class="muted">
							Downloads for players, such as Voxy data and Xaero presets.
						</p>
					)
				)}
				{(write || (tree.folder && tree.canManage)) && (
					<div class="file-toolbar">
						{write && (
							<>
								<button
									type="button"
									class="btn primary"
									onClick={() => pick.current?.click()}
								>
									Upload files
								</button>
								<button
									type="button"
									class="btn"
									onClick={() => setDialog({ kind: "newFolder" })}
								>
									New folder
								</button>
							</>
						)}
						{write && tree.folder && (
							<button
								type="button"
								class="btn"
								onClick={() => setDialog({ kind: "describe" })}
							>
								Edit description
							</button>
						)}
						{tree.folder && tree.canManage && (
							<button
								type="button"
								class="btn"
								onClick={() => setDialog({ kind: "access" })}
							>
								Access
							</button>
						)}
					</div>
				)}
				{write && (
					<p class="muted hint">
						Upload folders as a ZIP. Files up to{" "}
						{formatBytes(tree.limits.maxFileBytes)}; the library uses{" "}
						{formatBytes(tree.limits.usedBytes)} of{" "}
						{formatBytes(tree.limits.quotaBytes)}.
					</p>
				)}
				<input
					ref={pick}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						const files = [...(e.currentTarget.files ?? [])];
						e.currentTarget.value = "";
						enqueue(files);
					}}
				/>
				<input
					ref={replacePick}
					type="file"
					hidden
					onChange={(e) => {
						const chosen = e.currentTarget.files?.[0];
						e.currentTarget.value = "";
						const target = replacing.current;
						if (!chosen || !target) return;
						enqueue(
							[new File([chosen], target.name, { type: chosen.type })],
							"replace",
						);
					}}
				/>
			</section>

			{uploadsShown && (
				<UploadList
					jobs={jobs.current}
					busy={running.current}
					onCancel={cancelUploads}
					onClear={() => {
						jobs.current = jobs.current.filter(
							(j) => j.state === "waiting" || j.state === "uploading",
						);
						refresh();
					}}
				/>
			)}

			<section
				ref={listing}
				class={`page-section file-listing ${dragging ? "dragging" : ""}`}
			>
				{empty ? (
					<p class="muted">
						{write
							? "This folder is empty. Drop files here or use Upload files."
							: "This folder is empty."}
					</p>
				) : (
					<div>
						<table class="stats-table file-table">
							<thead>
								<tr>
									<th>Name</th>
									<th class="stats-num">Size</th>
									<th class="file-meta">Updated</th>
									<th class="file-meta">By</th>
									<th class="stats-num file-meta">Downloads</th>
									<th aria-label="Actions" />
								</tr>
							</thead>
							<tbody>
								{tree.folders.map((f) => (
									<tr key={`d${f.id}`}>
										<td class="file-name">
											<FolderLink href={f.url} go={go}>
												<PixelIcon name="chest" size={20} />
												<span>{f.name}</span>
											</FolderLink>
										</td>
										<td class="stats-num muted">
											{f.items === 1 ? "1 item" : `${f.items} items`}
										</td>
										<td class="file-meta muted">{formatTime(f.createdAt)}</td>
										<td class="file-meta" />
										<td class="file-meta" />
										<td class="file-actions">
											{write && (
												<RowMenu
													actions={[
														[
															"Rename",
															() =>
																setDialog({
																	kind: "rename",
																	target: { type: "folder", item: f },
																}),
														],
														[
															"Move",
															() =>
																setDialog({
																	kind: "move",
																	target: { type: "folder", item: f },
																}),
														],
														[
															"Delete",
															() => void deleteFolder(f, () => load()),
														],
													]}
												/>
											)}
										</td>
									</tr>
								))}
								{tree.files.map((f) => (
									<tr key={`f${f.id}`}>
										<td class="file-name">
											<a href={f.url} download={f.name}>
												<PixelIcon name="paper" size={20} />
												<span>{f.name}</span>
											</a>
										</td>
										<td class="stats-num">{formatBytes(f.bytes)}</td>
										<td class="file-meta muted">{formatTime(f.updatedAt)}</td>
										<td class="file-meta">
											<span class="stats-player">
												{f.uploadedBy.avatarUrl ? (
													<img
														class="avatar"
														src={f.uploadedBy.avatarUrl}
														alt=""
														width={20}
														height={20}
													/>
												) : (
													<span class="avatar placeholder" />
												)}
												{f.uploadedBy.username}
											</span>
										</td>
										<td class="stats-num file-meta">{f.downloads}</td>
										<td class="file-actions">
											<RowMenu
												actions={[
													["Copy link", () => void copyLink(f.url)],
													...(write
														? ([
																[
																	"Upload a new version",
																	() => {
																		replacing.current = f;
																		replacePick.current?.click();
																	},
																],
																[
																	"Rename",
																	() =>
																		setDialog({
																			kind: "rename",
																			target: { type: "file", item: f },
																		}),
																],
																[
																	"Move",
																	() =>
																		setDialog({
																			kind: "move",
																			target: { type: "file", item: f },
																		}),
																],
																[
																	"Delete",
																	() => void deleteFile(f, () => load()),
																],
															] as [string, () => void][])
														: []),
												]}
											/>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{dragging && (
					<div class="file-drop">Drop files to upload them here</div>
				)}
			</section>

			{dialog?.kind === "newFolder" && (
				<TextDialog
					title="New folder"
					label="Name"
					initial=""
					submit="Create"
					onClose={() => setDialog(null)}
					onSubmit={(name) =>
						ok(
							() =>
								api.api.files.folders.$post({
									json: { parentId: tree.folder?.id ?? null, name },
								}),
							() => load(),
						)
					}
				/>
			)}
			{dialog?.kind === "describe" && tree.folder && (
				<TextDialog
					title="Folder description"
					label="Shown above what the folder holds. **bold** and [links](https://…) work."
					initial={tree.folder.description}
					multiline
					submit="Save"
					onClose={() => setDialog(null)}
					onSubmit={(description) =>
						ok(
							() =>
								api.api.files.folders[":id"].$patch({
									param: { id: String(tree.folder?.id) },
									json: { description },
								}),
							() => load(),
						)
					}
				/>
			)}
			{dialog?.kind === "rename" && (
				<TextDialog
					title={`Rename ${dialog.target.type}`}
					label="Name"
					initial={dialog.target.item.name}
					submit="Rename"
					onClose={() => setDialog(null)}
					onSubmit={(name) => update(dialog.target, { name }, () => load())}
				/>
			)}
			{dialog?.kind === "move" && (
				<TextDialog
					title={`Move “${dialog.target.item.name}”`}
					label="To the folder (a path such as /voxy/worlds; / is the top)"
					initial={path}
					submit="Move"
					onClose={() => setDialog(null)}
					onSubmit={(to) => move(dialog.target, to, () => load())}
				/>
			)}
			{dialog?.kind === "conflict" && (
				<ConflictDialog
					name={dialog.name}
					folder={dialog.folder}
					answer={dialog.answer}
				/>
			)}
			{dialog?.kind === "access" && tree.folder && (
				<AccessDialog
					folderId={tree.folder.id}
					folderName={tree.folder.name}
					onClose={() => setDialog(null)}
				/>
			)}
		</>
	);
}

async function copyLink(url: string) {
	try {
		await navigator.clipboard.writeText(new URL(url, location.origin).href);
		showNotice("Link copied. Only logged-in users can download it.");
	} catch {
		showNotice("Could not copy the link.", "error");
	}
}

async function deleteFolder(f: FolderItem, after: () => Promise<void>) {
	const ask =
		f.items > 0
			? `Delete “${f.name}” and everything in it? This cannot be undone.`
			: `Delete the empty folder “${f.name}”?`;
	if (!confirm(ask)) return;
	await ok(
		() =>
			api.api.files.folders[":id"].$delete({
				param: { id: String(f.id) },
				query: { recursive: "1" },
			}),
		after,
	);
}

async function deleteFile(f: FileItem, after: () => Promise<void>) {
	if (!confirm(`Delete “${f.name}”? This cannot be undone.`)) return;
	await ok(
		() => api.api.files.entries[":id"].$delete({ param: { id: String(f.id) } }),
		after,
	);
}

function update(
	target: Target,
	patch: { name?: string; parentId?: number | null },
	after: () => Promise<void>,
) {
	const id = String(target.item.id);
	return target.type === "folder"
		? ok(
				() =>
					api.api.files.folders[":id"].$patch({ param: { id }, json: patch }),
				after,
			)
		: ok(
				() =>
					api.api.files.entries[":id"].$patch({
						param: { id },
						json: {
							name: patch.name,
							folderId: patch.parentId,
						},
					}),
				after,
			);
}

/** Moves to the folder at `to`, a path such as "/voxy/worlds". */
async function move(target: Target, to: string, after: () => Promise<void>) {
	const r = await attempt(() =>
		api.api.files.tree.$get({ query: { path: to } }),
	);
	if (!r.ok) {
		showNotice(
			r.status === 404 ? `There is no folder at ${to}.` : r.error,
			"error",
		);
		return false;
	}
	return update(target, { parentId: r.body.folder?.id ?? null }, after);
}

/** A small menu of actions for one row. */
function RowMenu(props: { actions: [string, () => void][] }) {
	const ref = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			const el = ref.current;
			if (el?.open && !el.contains(e.target as Node)) el.open = false;
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, []);
	if (props.actions.length === 0) return null;
	return (
		<details class="row-menu" ref={ref}>
			<summary class="btn small" aria-label="Actions">
				⋯
			</summary>
			<div class="row-menu-list">
				{props.actions.map(([label, run]) => (
					<button
						key={label}
						type="button"
						class="plain"
						onClick={() => {
							if (ref.current) ref.current.open = false;
							run();
						}}
					>
						{label}
					</button>
				))}
			</div>
		</details>
	);
}

function UploadList(props: {
	jobs: Job[];
	busy: boolean;
	onCancel: () => void;
	onClear: () => void;
}) {
	const finished = props.jobs.filter((j) => j.state === "done").length;
	return (
		<section class="page-section">
			<h2>
				Uploads ({finished} of {props.jobs.length} done)
			</h2>
			<ul class="upload-jobs">
				{props.jobs.map((j) => {
					const percent =
						j.file.size > 0 ? Math.min(100, (j.loaded / j.file.size) * 100) : 0;
					return (
						<li key={j.key}>
							<div class="upload-job-head">
								<span class="upload-job-name">
									{j.file.name}
									<span class="muted"> · {j.folder}</span>
								</span>
								<span class={j.state === "failed" ? "error-text" : "muted"}>
									{j.state === "uploading"
										? `${formatBytes(j.loaded)} of ${formatBytes(j.file.size)}`
										: j.state === "failed"
											? j.error
											: j.state === "done"
												? `Done · ${formatBytes(j.file.size)}`
												: j.state === "skipped"
													? "Skipped"
													: "Waiting"}
								</span>
							</div>
							{j.state === "uploading" && (
								<div class="progress">
									<div class="bar" style={{ width: `${percent}%` }} />
								</div>
							)}
						</li>
					);
				})}
			</ul>
			<div class="modal-actions">
				{props.busy ? (
					<button type="button" class="btn" onClick={props.onCancel}>
						Cancel uploads
					</button>
				) : (
					<button type="button" class="btn" onClick={props.onClear}>
						Clear
					</button>
				)}
			</div>
		</section>
	);
}

function TextDialog(props: {
	title: string;
	label: string;
	initial: string;
	submit: string;
	multiline?: boolean;
	onClose: () => void;
	onSubmit: (value: string) => Promise<boolean>;
}) {
	const [value, setValue] = useState(props.initial);
	const [busy, setBusy] = useState(false);
	return (
		<Modal title={props.title} onClose={props.onClose}>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					setBusy(true);
					try {
						if (await props.onSubmit(props.multiline ? value : value.trim()))
							props.onClose();
					} finally {
						setBusy(false);
					}
				}}
			>
				{props.multiline ? (
					<label class="field">
						<span class="label">{props.label}</span>
						<textarea
							rows={6}
							value={value}
							onInput={(e) => setValue(e.currentTarget.value)}
						/>
					</label>
				) : (
					<label class="field">
						<span class="label">{props.label}</span>
						<input
							type="text"
							value={value}
							onInput={(e) => setValue(e.currentTarget.value)}
						/>
					</label>
				)}
				<div class="modal-actions">
					<button
						type="submit"
						class="btn primary"
						disabled={busy || (!props.multiline && !value.trim())}
					>
						{props.submit}
					</button>
					<button type="button" class="btn" onClick={props.onClose}>
						Cancel
					</button>
				</div>
			</form>
		</Modal>
	);
}

function ConflictDialog(props: {
	name: string;
	folder: boolean;
	answer: (choice: ConflictChoice) => void;
}) {
	const [forAll, setForAll] = useState(false);
	const pick = (mode: ConflictChoice["mode"]) => props.answer({ mode, forAll });
	return (
		<Modal title="Name already taken" onClose={() => pick("skip")}>
			<p>
				{props.folder
					? `There is a folder called “${props.name}” here already.`
					: `There is a file called “${props.name}” here already.`}
			</p>
			<p class="muted">
				Replacing keeps the existing link and download count. Keeping both
				uploads this one with a number added to its name.
			</p>
			<label class="check">
				<input
					type="checkbox"
					checked={forAll}
					onChange={(e) => setForAll(e.currentTarget.checked)}
				/>
				Do the same for the rest of these uploads
			</label>
			<div class="modal-actions">
				{!props.folder && (
					<button
						type="button"
						class="btn primary"
						onClick={() => pick("replace")}
					>
						Replace
					</button>
				)}
				<button type="button" class="btn" onClick={() => pick("rename")}>
					Keep both
				</button>
				<button type="button" class="btn" onClick={() => pick("skip")}>
					Skip
				</button>
			</div>
		</Modal>
	);
}

type Grant = {
	userId: string;
	username: string;
	avatarUrl: string | null;
	path?: string;
};

/** Who may change the folder, for moderators: add people by Discord id, or take access away. */
function AccessDialog(props: {
	folderId: number;
	folderName: string;
	onClose: () => void;
}) {
	const id = String(props.folderId);
	const [grants, setGrants] = useState<Grant[] | null>(null);
	const [inherited, setInherited] = useState<Grant[]>([]);
	const [newId, setNewId] = useState("");
	const [busy, setBusy] = useState(false);

	const reload = async () => {
		const r = await attempt(() =>
			api.api.files.folders[":id"].grants.$get({ param: { id } }),
		);
		if (!r.ok) {
			showNotice(r.error, "error");
			return;
		}
		setGrants(r.body.grants);
		setInherited(r.body.inherited);
	};
	useEffect(() => {
		void reload();
	}, [id]);

	const act = async (fn: () => Promise<boolean>) => {
		setBusy(true);
		try {
			return await fn();
		} finally {
			setBusy(false);
		}
	};

	const person = (g: Grant) => (
		<>
			{g.avatarUrl ? (
				<img class="avatar" src={g.avatarUrl} alt="" width={24} height={24} />
			) : (
				<span class="avatar placeholder" />
			)}
			<span class="member-name">{g.username}</span>
		</>
	);

	return (
		<Modal title={`Access to “${props.folderName}”`} onClose={props.onClose}>
			<p class="muted">
				These people may upload, rename, move and delete files and folders in
				this folder and below it. Moderators always can.
			</p>
			{grants === null && <p class="muted">Loading…</p>}
			{grants?.length === 0 && inherited.length === 0 && (
				<p class="muted">Nobody else yet.</p>
			)}
			<ul class="member-list">
				{grants?.map((g) => (
					<li key={g.userId}>
						{person(g)}
						<button
							type="button"
							class="btn small danger"
							disabled={busy}
							onClick={() =>
								void act(() =>
									ok(
										() =>
											api.api.files.folders[":id"].grants[":userId"].$delete({
												param: { id, userId: g.userId },
											}),
										reload,
									),
								)
							}
						>
							Remove
						</button>
					</li>
				))}
				{inherited.map((g) => (
					<li key={`${g.path}:${g.userId}`}>
						{person(g)}
						<span class="muted" title="Given a folder above this one">
							from {g.path}
						</span>
					</li>
				))}
			</ul>
			<form
				class="add-member"
				onSubmit={async (e) => {
					e.preventDefault();
					const userId = newId.trim();
					if (!userId) return;
					const done = await act(() =>
						ok(
							() =>
								api.api.files.folders[":id"].grants.$post({
									param: { id },
									json: { userId },
								}),
							reload,
						),
					);
					if (done) setNewId("");
				}}
			>
				<input
					type="text"
					inputMode="numeric"
					placeholder="Discord user id"
					aria-label="Discord user id"
					value={newId}
					onInput={(e) => setNewId(e.currentTarget.value)}
				/>
				<button type="submit" class="btn" disabled={busy || !newId.trim()}>
					Add
				</button>
			</form>
			<p class="muted hint">
				They must have logged in once. Enable Developer Mode in Discord and use
				“Copy User ID”.
			</p>
		</Modal>
	);
}

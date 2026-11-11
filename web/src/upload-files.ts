export type UploadItem = {
	file: File;
	/** Where the file came from, folders included; the export date is read from it. */
	path: string;
};

export const itemKey = (i: UploadItem) => `${i.path}:${i.file.size}`;

/** Files from an <input>; a chosen folder gives each file its path inside it. */
export const fromFileList = (list: FileList | File[]): UploadItem[] =>
	[...list].map((file) => ({
		file,
		path: file.webkitRelativePath || file.name,
	}));

const wanted = (name: string) => /\.(png|zip)$/i.test(name);

async function walk(
	entry: FileSystemEntry,
	prefix: string,
	out: UploadItem[],
	inFolder: boolean,
): Promise<void> {
	if (entry.isFile) {
		// Inside a folder, skip what is not an export (thumbnails, notes, hidden files).
		if (inFolder && (!wanted(entry.name) || entry.name.startsWith("."))) return;
		const file = await new Promise<File>((resolve, reject) =>
			(entry as FileSystemFileEntry).file(resolve, reject),
		);
		out.push({ file, path: prefix + entry.name });
		return;
	}
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
			reader.readEntries(resolve, reject),
		);
		if (batch.length === 0) return;
		for (const child of batch) {
			await walk(child, `${prefix}${entry.name}/`, out, true);
		}
	}
}

/** Files and whole folders dropped onto the dialog. */
export async function fromDrop(dt: DataTransfer): Promise<UploadItem[]> {
	// Entries must be taken before the first await: the data transfer is cleared afterwards.
	const entries = [...dt.items]
		.filter((i) => i.kind === "file")
		.map((i) => i.webkitGetAsEntry?.() ?? null);
	if (entries.length === 0 || entries.some((e) => e === null)) {
		return fromFileList(dt.files);
	}
	const out: UploadItem[] = [];
	for (const entry of entries) {
		if (entry) await walk(entry, "", out, false);
	}
	return out;
}

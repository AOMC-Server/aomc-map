import { fileNameKey, fileUrl } from "@aomc/shared";
import { and, eq, isNull, type SQLWrapper, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { fileEntries, fileFolders, fileGrants } from "../db/schema";

type Reader = Pick<Db, "select" | "all">;

export type FolderRow = typeof fileFolders.$inferSelect;
export type EntryRow = typeof fileEntries.$inferSelect;

/** A folder and the ones above it, top first; for the top of the library both are empty. */
export type FolderPath = { folder: FolderRow | null; chain: FolderRow[] };

const inFolder = (column: SQLWrapper, id: number | null) =>
	id === null ? isNull(column) : eq(column, id);

export const childFolders = (db: Reader, parentId: number | null) =>
	db
		.select()
		.from(fileFolders)
		.where(inFolder(fileFolders.parentId, parentId))
		.all();

export const childEntries = (db: Reader, folderId: number | null) =>
	db
		.select()
		.from(fileEntries)
		.where(inFolder(fileEntries.folderId, folderId))
		.all();

/** What has the name in the folder (ignoring case), if anything. */
export function findChild(
	db: Reader,
	parentId: number | null,
	name: string,
): { kind: "folder"; row: FolderRow } | { kind: "file"; row: EntryRow } | null {
	const key = fileNameKey(name);
	const folder = childFolders(db, parentId).find(
		(f) => fileNameKey(f.name) === key,
	);
	if (folder) return { kind: "folder", row: folder };
	const entry = childEntries(db, parentId).find(
		(e) => fileNameKey(e.name) === key,
	);
	return entry ? { kind: "file", row: entry } : null;
}

/** Whether the name is free in the folder, not counting the thing being renamed. */
export function nameFree(
	db: Reader,
	parentId: number | null,
	name: string,
	except?: { kind: "folder" | "file"; id: number },
) {
	const found = findChild(db, parentId, name);
	return !found || (found.kind === except?.kind && found.row.id === except?.id);
}

export const folderById = (db: Reader, id: number) =>
	db.select().from(fileFolders).where(eq(fileFolders.id, id)).get() ?? null;

export const entryById = (db: Reader, id: number) =>
	db.select().from(fileEntries).where(eq(fileEntries.id, id)).get() ?? null;

/** The folder with this id and the ones above it; null when there is no such folder. */
export function folderPathById(
	db: Reader,
	id: number | null,
): FolderPath | null {
	if (id === null) return { folder: null, chain: [] };
	const chain: FolderRow[] = [];
	let next: number | null = id;
	while (next !== null) {
		const row = folderById(db, next);
		if (!row) return null;
		chain.unshift(row);
		next = row.parentId;
	}
	return { folder: chain.at(-1) ?? null, chain };
}

/** Follows folder names from the top (ignoring case); null when one of them is missing. */
export function resolveFolder(
	db: Reader,
	names: readonly string[],
): FolderPath | null {
	const chain: FolderRow[] = [];
	for (const name of names) {
		const key = fileNameKey(name);
		const row = childFolders(db, chain.at(-1)?.id ?? null).find(
			(f) => fileNameKey(f.name) === key,
		);
		if (!row) return null;
		chain.push(row);
	}
	return { folder: chain.at(-1) ?? null, chain };
}

/** The file named by the path, with its folder; null when it does not exist. */
export function resolveEntry(db: Reader, names: readonly string[]) {
	const name = names.at(-1);
	if (name === undefined) return null;
	const folder = resolveFolder(db, names.slice(0, -1));
	if (!folder) return null;
	const found = findChild(db, folder.folder?.id ?? null, name);
	return found?.kind === "file" ? { entry: found.row, ...folder } : null;
}

/** Where a file or folder is downloaded or browsed. */
export const urlOf = (chain: readonly FolderRow[], name?: string) =>
	fileUrl(
		name === undefined
			? chain.map((f) => f.name)
			: [...chain.map((f) => f.name), name],
		name === undefined,
	);

export const pathOf = (chain: readonly FolderRow[]) =>
	`/${chain.map((f) => f.name).join("/")}`;

/** The folders a user was given write access to. */
export function grantedFolders(db: Reader, userId: string | undefined) {
	if (!userId) return new Set<number>();
	return new Set(
		db
			.select({ id: fileGrants.folderId })
			.from(fileGrants)
			.where(eq(fileGrants.userId, userId))
			.all()
			.map((r) => r.id),
	);
}

/** Bytes the library takes on disk: content shared by several files counts once. */
export function filesUsage(db: Reader): { files: number; bytes: number } {
	const [row] = db.all<{ files: number; bytes: number }>(sql`
		SELECT (SELECT COUNT(*) FROM file_entries) AS files,
			COALESCE((SELECT SUM(bytes) FROM (SELECT DISTINCT hash, bytes FROM file_entries)), 0) AS bytes`);
	return row ?? { files: 0, bytes: 0 };
}

export const hashUsed = (db: Reader, hash: string) =>
	db
		.select({ id: fileEntries.id })
		.from(fileEntries)
		.where(eq(fileEntries.hash, hash))
		.limit(1)
		.get() !== undefined;

/** Every content hash in use, for the sweep on start. */
export const usedHashes = (db: Db) =>
	new Set(
		db
			.selectDistinct({ hash: fileEntries.hash })
			.from(fileEntries)
			.all()
			.map((r) => r.hash),
	);

/** Content hashes of the files in a folder and below it. */
export function hashesUnder(db: Reader, id: number): string[] {
	return db
		.all<{ hash: string }>(sql`
			WITH RECURSIVE sub(id) AS (
				SELECT ${id}
				UNION ALL SELECT f.id FROM file_folders f JOIN sub ON f.parent_id = sub.id
			)
			SELECT DISTINCT hash FROM file_entries WHERE folder_id IN (SELECT id FROM sub)`)
		.map((r) => r.hash);
}

/** How many folders and files a folder holds directly. */
export function childCounts(db: Reader, parentId: number | null) {
	const parent = parentId === null ? sql`IS NULL` : sql`= ${parentId}`;
	const folders = db.all<{ parent: number; n: number }>(sql`
		SELECT f.id AS parent,
			(SELECT COUNT(*) FROM file_folders c WHERE c.parent_id = f.id)
			+ (SELECT COUNT(*) FROM file_entries e WHERE e.folder_id = f.id) AS n
		FROM file_folders f WHERE f.parent_id ${parent}`);
	return new Map(folders.map((r) => [r.parent, r.n]));
}

export const grantExists = (db: Reader, folderId: number, userId: string) =>
	db
		.select({ id: fileGrants.folderId })
		.from(fileGrants)
		.where(
			and(eq(fileGrants.folderId, folderId), eq(fileGrants.userId, userId)),
		)
		.get() !== undefined;

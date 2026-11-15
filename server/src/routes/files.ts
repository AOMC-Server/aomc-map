import {
	createFileFolderSchema,
	fileGrantSchema,
	fileTreeQuerySchema,
	fileUploadQuerySchema,
	numberedFileName,
	splitFilePath,
	updateFileEntrySchema,
	updateFileFolderSchema,
} from "@aomc/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser, userOf } from "../auth/session";
import type { Db } from "../db/client";
import { fileEntries, fileFolders, fileGrants, users } from "../db/schema";
import {
	childCounts,
	childFolders,
	type EntryRow,
	entryById,
	type FolderRow,
	filesUsage,
	findChild,
	folderPathById,
	grantedFolders,
	hashesUnder,
	hashUsed,
	nameFree,
	pathOf,
	resolveFolder,
	urlOf,
} from "../files/library";
import { type Received, TooLargeError } from "../files/store";
import { doc } from "../openapi";
import { canManageFiles, canWriteFolder } from "../permissions";
import type { AppEnv } from "../types";
import { validate } from "../validate";
import { findUser, parseId, UNKNOWN_USER_ERROR } from "./util";

type Tx = Pick<Db, "select" | "insert" | "update" | "delete" | "all">;

/** Run the checks and the writes that depend on them as one unit. */
const atomically = <T>(db: Db, fn: (tx: Tx) => T) =>
	db.transaction(fn, { behavior: "immediate" });

type Ctx = {
	var: AppEnv["Variables"];
};

/** Whether the actor may change things in the folder at the end of `chain` (empty: the top). */
function writeCheck(c: Ctx) {
	const granted = grantedFolders(c.var.db, c.var.user?.id);
	return (chain: readonly FolderRow[]) =>
		canWriteFolder(
			c.var.role,
			chain.map((f) => f.id),
			granted,
		);
}

const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { numeric: true });

type Uploader = { id: string; username: string; avatarUrl: string | null };

function entryJson(e: EntryRow, chain: readonly FolderRow[], by: Uploader) {
	return {
		id: e.id,
		folderId: e.folderId,
		name: e.name,
		bytes: e.bytes,
		sha256: e.hash,
		createdAt: e.createdAt,
		updatedAt: e.updatedAt,
		downloads: e.downloads,
		url: urlOf(chain, e.name),
		uploadedBy: by,
	};
}

const uploaderOf = (db: Db, id: string): Uploader =>
	db
		.select({
			id: users.id,
			username: users.username,
			avatarUrl: users.avatarUrl,
		})
		.from(users)
		.where(eq(users.id, id))
		.get() ?? { id, username: "?", avatarUrl: null };

const folderJson = (f: FolderRow, chain: readonly FolderRow[]) => ({
	id: f.id,
	parentId: f.parentId,
	name: f.name,
	description: f.description,
	createdAt: f.createdAt,
	path: pathOf(chain),
	url: urlOf(chain),
});

const TAKEN = "something with that name is already there";

/** Removes contents no file uses any more, taking turns with uploads. */
const dropUnused = (c: Ctx, hashes: string[]) =>
	c.var.svc.files.exclusive(() =>
		c.var.svc.files.removeUnused(hashes, (h) => hashUsed(c.var.db, h)),
	);

export const fileRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get(
		"/tree",
		doc({
			tag: "Files",
			summary: "List a folder",
			description:
				"`path` names the folder, like `/voxy/world` (default `/`, the top), ignoring case. Answers the folder (null for the top), the folders above it, what it holds (each folder with its number of `items`, each file with its `url`), whether you may change things in it (`canWrite`, also per folder) and give others access (`canManage`), and the limits: `maxFileBytes`, `quotaBytes` and `usedBytes`.",
			fails: [400, 404],
			login: true,
		}),
		validate("query", fileTreeQuerySchema),
		(c) => {
			const { db, env } = c.var;
			const found = resolveFolder(db, splitFilePath(c.req.valid("query").path));
			if (!found) return c.json({ error: "not found" }, 404);
			const { folder, chain } = found;
			const parentId = folder?.id ?? null;
			const mayWrite = writeCheck(c);
			const counts = childCounts(db, parentId);

			const entries = db
				.select({
					entry: fileEntries,
					by: {
						id: users.id,
						username: users.username,
						avatarUrl: users.avatarUrl,
					},
				})
				.from(fileEntries)
				.innerJoin(users, eq(users.id, fileEntries.uploadedBy))
				.where(
					parentId === null
						? isNull(fileEntries.folderId)
						: eq(fileEntries.folderId, parentId),
				)
				.all()
				.sort((a, b) => byName(a.entry, b.entry));

			return c.json({
				folder: folder && folderJson(folder, chain),
				path: pathOf(chain),
				url: urlOf(chain),
				breadcrumbs: chain.map((f, i) => ({
					id: f.id,
					name: f.name,
					url: urlOf(chain.slice(0, i + 1)),
				})),
				folders: childFolders(db, parentId)
					.sort(byName)
					.map((f) => ({
						...folderJson(f, [...chain, f]),
						items: counts.get(f.id) ?? 0,
						canWrite: mayWrite([...chain, f]),
					})),
				files: entries.map((r) => entryJson(r.entry, chain, r.by)),
				canWrite: mayWrite(chain),
				canManage: canManageFiles(c.var.role),
				limits: {
					maxFileBytes: env.MAX_FILE_BYTES,
					quotaBytes: env.FILES_QUOTA_BYTES,
					usedBytes: filesUsage(db).bytes,
				},
			});
		},
	)
	.put(
		"/upload",
		doc({
			tag: "Files",
			summary: "Upload a file",
			description: [
				"Send the file's bytes as the request body (not multipart), with a `Content-Length`: for example `curl -T world.zip -H 'Authorization: Bearer aomc_…' '<site>/api/files/upload?path=/voxy&name=world.zip'`. `path` is the folder, which must exist; `name` is the file's name. Folders can't be uploaded: send a ZIP.",
				"",
				"When the folder already has something called `name` (ignoring case), `onConflict` decides: `fail` (default) answers 409 with `conflict` (`file` or `folder`); `replace` gives the existing file the new content, keeping its link and download count; `rename` keeps both, numbering the new one like `world (2).zip`.",
				"",
				"Files are limited to `MAX_FILE_BYTES` (413) and the library to `FILES_QUOTA_BYTES` (507); see `limits` in `GET /api/files/tree`. Needs write access to the folder; tokens need the `upload` scope.",
			].join("\n"),
			ok: {
				201: "Stored. `file` is the file, `replaced` whether it replaced one",
			},
			fails: [400, 403, 404, 409, 411, 413, 429, 507],
			login: true,
			requestBody: {
				required: true,
				content: {
					"application/octet-stream": {
						schema: { type: "string", format: "binary" },
					},
				},
			},
		}),
		validate("query", fileUploadQuerySchema),
		async (c) => {
			const { db, env, svc } = c.var;
			const user = userOf(c);
			const query = c.req.valid("query");
			const target = resolveFolder(db, splitFilePath(query.path));
			if (!target) return c.json({ error: "folder not found" }, 404);
			const mayWrite = writeCheck(c);
			if (!mayWrite(target.chain)) return c.json({ error: "forbidden" }, 403);

			const folderId = target.folder?.id ?? null;
			const existing = findChild(db, folderId, query.name);
			if (
				existing &&
				(query.onConflict === "fail" ||
					(query.onConflict === "replace" && existing.kind === "folder"))
			) {
				return c.json(
					{
						error:
							existing.kind === "folder"
								? "a folder with that name is already there"
								: "a file with that name is already there",
						conflict: existing.kind,
					},
					409,
				);
			}

			const length = c.req.header("content-length");
			const declared = Number(length);
			if (!length || !Number.isSafeInteger(declared) || declared < 0)
				return c.json({ error: "Content-Length is required" }, 411);
			if (declared > env.MAX_FILE_BYTES)
				return c.json({ error: "file too large" }, 413);
			if (!svc.limiter.hit(user.id))
				return c.json({ error: "too many uploads, slow down" }, 429);
			const release = svc.files.reserve(
				declared,
				filesUsage(db).bytes,
				env.FILES_QUOTA_BYTES,
			);
			if (!release)
				return c.json(
					{ error: "the file library is full: there is no room for this file" },
					507,
				);

			let received: Received | null = null;
			try {
				try {
					received = await svc.files.receive(c.req.raw.body, declared);
				} catch (err) {
					if (err instanceof TooLargeError)
						return c.json({ error: "more data than Content-Length" }, 400);
					if ((err as { name?: string }).name === "AbortError")
						return c.json({ error: "the upload was cut short" }, 400);
					if ((err as { code?: string }).code === "ENOSPC")
						return c.json({ error: "the server's disk is full" }, 507);
					throw err;
				}
				if (received.bytes !== declared)
					return c.json({ error: "the upload was cut short" }, 400);

				const got = received;
				const outcome = await svc.files.exclusive(async () => {
					await svc.files.place(got);
					const result = atomically(db, (tx) => {
						const folder = folderPathById(tx, folderId);
						if (!folder) return { error: "gone" as const };
						const now = Date.now();
						const clash = findChild(tx, folderId, query.name);
						if (clash?.kind === "file" && query.onConflict === "replace") {
							const row = tx
								.update(fileEntries)
								.set({
									hash: got.hash,
									bytes: got.bytes,
									uploadedBy: user.id,
									updatedAt: now,
								})
								.where(eq(fileEntries.id, clash.row.id))
								.returning()
								.get();
							return { row, chain: folder.chain, old: clash.row.hash };
						}
						let name = query.name;
						if (clash) {
							if (query.onConflict !== "rename")
								return { error: "taken" as const, kind: clash.kind };
							for (let n = 2; !nameFree(tx, folderId, name); n++)
								name = numberedFileName(query.name, n);
						}
						const row = tx
							.insert(fileEntries)
							.values({
								folderId,
								name,
								hash: got.hash,
								bytes: got.bytes,
								uploadedBy: user.id,
								createdAt: now,
								updatedAt: now,
							})
							.returning()
							.get();
						return { row, chain: folder.chain, old: null };
					});
					const unused = "error" in result ? [got.hash] : [result.old ?? ""];
					await svc.files.removeUnused(unused, (h) => hashUsed(db, h));
					return result;
				});

				if ("error" in outcome) {
					return outcome.error === "gone"
						? c.json({ error: "folder not found" }, 404)
						: c.json({ error: TAKEN, conflict: outcome.kind }, 409);
				}
				return c.json(
					{
						file: entryJson(
							outcome.row,
							outcome.chain,
							uploaderOf(db, user.id),
						),
						replaced: outcome.old !== null,
					},
					201,
				);
			} finally {
				release();
				if (received) await svc.files.discard(received);
			}
		},
	)
	.post(
		"/folders",
		doc({
			tag: "Files",
			summary: "Create a folder",
			description:
				"`parentId` null makes it at the top. Needs write access to the parent (only moderators at the top).",
			ok: { 201: "Created" },
			fails: [400, 403, 404, 409],
			login: true,
		}),
		validate("json", createFileFolderSchema),
		(c) => {
			const { db } = c.var;
			const body = c.req.valid("json");
			const mayWrite = writeCheck(c);
			const result = atomically(db, (tx) => {
				const parent = folderPathById(tx, body.parentId);
				if (!parent) return "missing" as const;
				if (!mayWrite(parent.chain)) return "forbidden" as const;
				if (!nameFree(tx, body.parentId, body.name)) return "taken" as const;
				const row = tx
					.insert(fileFolders)
					.values({
						parentId: body.parentId,
						name: body.name,
						description: body.description,
						createdBy: userOf(c).id,
					})
					.returning()
					.get();
				return { row, chain: [...parent.chain, row] };
			});
			if (result === "missing") return c.json({ error: "not found" }, 404);
			if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
			if (result === "taken") return c.json({ error: TAKEN }, 409);
			return c.json({ folder: folderJson(result.row, result.chain) }, 201);
		},
	)
	.patch(
		"/folders/:id",
		doc({
			tag: "Files",
			summary: "Rename, describe or move a folder",
			description:
				"The description needs write access to the folder; renaming and moving need it for the folder it is in, and moving also for the destination (`parentId`, null for the top). A folder can't move into itself or below itself (409).",
			fails: [400, 403, 404, 409],
			login: true,
		}),
		validate("json", updateFileFolderSchema),
		(c) => {
			const { db } = c.var;
			const id = parseId(c.req.param("id"));
			const body = c.req.valid("json");
			const mayWrite = writeCheck(c);
			const result = atomically(db, (tx) => {
				const found = Number.isSafeInteger(id) ? folderPathById(tx, id) : null;
				const folder = found?.folder;
				if (!found || !folder) return "missing" as const;
				const above = found.chain.slice(0, -1);
				if (body.description !== undefined && !mayWrite(found.chain))
					return "forbidden" as const;

				const moving =
					body.parentId !== undefined && body.parentId !== folder.parentId;
				const renaming = body.name !== undefined && body.name !== folder.name;
				if ((moving || renaming) && !mayWrite(above))
					return "forbidden" as const;
				let parentId = folder.parentId;
				if (moving) {
					const dest = folderPathById(tx, body.parentId ?? null);
					if (!dest) return "missing" as const;
					if (dest.chain.some((f) => f.id === folder.id))
						return "cycle" as const;
					if (!mayWrite(dest.chain)) return "forbidden" as const;
					parentId = body.parentId ?? null;
				}
				const name = body.name ?? folder.name;
				if (
					(moving || renaming) &&
					!nameFree(tx, parentId, name, { kind: "folder", id: folder.id })
				)
					return "taken" as const;
				const row = tx
					.update(fileFolders)
					.set({
						name,
						parentId,
						description: body.description ?? folder.description,
					})
					.where(eq(fileFolders.id, folder.id))
					.returning()
					.get();
				const chain = folderPathById(tx, row.id)?.chain ?? [row];
				return { row, chain };
			});
			if (result === "missing") return c.json({ error: "not found" }, 404);
			if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
			if (result === "taken") return c.json({ error: TAKEN }, 409);
			if (result === "cycle")
				return c.json({ error: "a folder can't be moved into itself" }, 409);
			return c.json({ folder: folderJson(result.row, result.chain) });
		},
	)
	.delete(
		"/folders/:id",
		doc({
			tag: "Files",
			summary: "Delete a folder",
			description:
				"Needs write access to the folder it is in. A folder that holds anything is only deleted with `recursive=1`, along with everything in it (409 otherwise).",
			fails: [403, 404, 409],
			login: true,
		}),
		validate(
			"query",
			z.object({
				/** `1` to delete what the folder holds too. */
				recursive: z.enum(["0", "1"]).optional(),
			}),
		),
		async (c) => {
			const { db } = c.var;
			const id = parseId(c.req.param("id"));
			const recursive = c.req.valid("query").recursive === "1";
			const mayWrite = writeCheck(c);
			const result = atomically(db, (tx) => {
				const found = Number.isSafeInteger(id) ? folderPathById(tx, id) : null;
				if (!found?.folder) return "missing" as const;
				if (!mayWrite(found.chain.slice(0, -1))) return "forbidden" as const;
				const holds =
					childFolders(tx, id).length > 0 ||
					tx
						.select({ id: fileEntries.id })
						.from(fileEntries)
						.where(eq(fileEntries.folderId, id))
						.limit(1)
						.get() !== undefined;
				if (holds && !recursive) return "not empty" as const;
				const hashes = hashesUnder(tx, id);
				tx.delete(fileFolders).where(eq(fileFolders.id, id)).run();
				return hashes;
			});
			if (result === "missing") return c.json({ error: "not found" }, 404);
			if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
			if (result === "not empty")
				return c.json({ error: "the folder is not empty" }, 409);
			await dropUnused(c, result);
			return c.json({ ok: true });
		},
	)
	.patch(
		"/entries/:id",
		doc({
			tag: "Files",
			summary: "Rename or move a file",
			description:
				"Needs write access to the file's folder, and to the destination (`folderId`, null for the top) when moving it.",
			fails: [400, 403, 404, 409],
			login: true,
		}),
		validate("json", updateFileEntrySchema),
		(c) => {
			const { db } = c.var;
			const id = parseId(c.req.param("id"));
			const body = c.req.valid("json");
			const mayWrite = writeCheck(c);
			const result = atomically(db, (tx) => {
				const entry = Number.isSafeInteger(id) ? entryById(tx, id) : null;
				const source = entry && folderPathById(tx, entry.folderId);
				if (!entry || !source) return "missing" as const;
				if (!mayWrite(source.chain)) return "forbidden" as const;
				let dest = source;
				if (body.folderId !== undefined && body.folderId !== entry.folderId) {
					const to = folderPathById(tx, body.folderId);
					if (!to) return "missing" as const;
					if (!mayWrite(to.chain)) return "forbidden" as const;
					dest = to;
				}
				const folderId = dest.folder?.id ?? null;
				const name = body.name ?? entry.name;
				if (!nameFree(tx, folderId, name, { kind: "file", id: entry.id }))
					return "taken" as const;
				const row = tx
					.update(fileEntries)
					.set({ name, folderId })
					.where(eq(fileEntries.id, entry.id))
					.returning()
					.get();
				return { row, chain: dest.chain };
			});
			if (result === "missing") return c.json({ error: "not found" }, 404);
			if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
			if (result === "taken") return c.json({ error: TAKEN }, 409);
			return c.json({
				file: entryJson(
					result.row,
					result.chain,
					uploaderOf(db, result.row.uploadedBy),
				),
			});
		},
	)
	.delete(
		"/entries/:id",
		doc({
			tag: "Files",
			summary: "Delete a file",
			description: "Needs write access to the file's folder.",
			fails: [403, 404],
			login: true,
		}),
		async (c) => {
			const { db } = c.var;
			const id = parseId(c.req.param("id"));
			const mayWrite = writeCheck(c);
			const result = atomically(db, (tx) => {
				const entry = Number.isSafeInteger(id) ? entryById(tx, id) : null;
				const folder = entry && folderPathById(tx, entry.folderId);
				if (!entry || !folder) return "missing" as const;
				if (!mayWrite(folder.chain)) return "forbidden" as const;
				tx.delete(fileEntries).where(eq(fileEntries.id, entry.id)).run();
				return entry.hash;
			});
			if (result === "missing") return c.json({ error: "not found" }, 404);
			if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
			await dropUnused(c, [result]);
			return c.json({ ok: true });
		},
	)
	.get(
		"/folders/:id/grants",
		doc({
			tag: "Files",
			summary: "List who may change a folder",
			description:
				"Moderators. `grants` are the people given this folder; `inherited` those given a folder above it, which covers this one too. Moderators may change every folder and are not listed.",
			fails: [403, 404],
			login: true,
		}),
		(c) => {
			const { db } = c.var;
			if (!canManageFiles(c.var.role))
				return c.json({ error: "forbidden" }, 403);
			const id = parseId(c.req.param("id"));
			const found = Number.isSafeInteger(id) ? folderPathById(db, id) : null;
			if (!found?.folder) return c.json({ error: "not found" }, 404);
			const rows = db
				.select({
					folderId: fileGrants.folderId,
					userId: fileGrants.userId,
					createdAt: fileGrants.createdAt,
					username: users.username,
					avatarUrl: users.avatarUrl,
				})
				.from(fileGrants)
				.innerJoin(users, eq(users.id, fileGrants.userId))
				.where(
					inArray(
						fileGrants.folderId,
						found.chain.map((f) => f.id),
					),
				)
				.all();
			const folderOf = new Map(found.chain.map((f, i) => [f.id, i]));
			return c.json({
				grants: rows.filter((r) => r.folderId === id),
				inherited: rows
					.filter((r) => r.folderId !== id)
					.map((r) => {
						const at = folderOf.get(r.folderId) ?? 0;
						return {
							...r,
							path: pathOf(found.chain.slice(0, at + 1)),
						};
					}),
			});
		},
	)
	.post(
		"/folders/:id/grants",
		doc({
			tag: "Files",
			summary: "Let someone change a folder",
			description:
				"Moderators. They may then add, rename, move and delete files and folders in it and below it. The user must have logged in once.",
			ok: { 201: "Given" },
			fails: [400, 403, 404],
			login: true,
		}),
		validate("json", fileGrantSchema),
		(c) => {
			const { db } = c.var;
			if (!canManageFiles(c.var.role))
				return c.json({ error: "forbidden" }, 403);
			const id = parseId(c.req.param("id"));
			const folder = Number.isSafeInteger(id) ? folderPathById(db, id) : null;
			if (!folder?.folder) return c.json({ error: "not found" }, 404);
			const { userId } = c.req.valid("json");
			if (!findUser(db, userId))
				return c.json({ error: UNKNOWN_USER_ERROR }, 404);
			db.insert(fileGrants)
				.values({ folderId: id, userId })
				.onConflictDoNothing()
				.run();
			return c.json({ ok: true }, 201);
		},
	)
	.delete(
		"/folders/:id/grants/:userId",
		doc({
			tag: "Files",
			summary: "Take away someone's access to a folder",
			description: "Moderators.",
			fails: [403, 404],
			login: true,
		}),
		(c) => {
			const { db } = c.var;
			if (!canManageFiles(c.var.role))
				return c.json({ error: "forbidden" }, 403);
			const id = parseId(c.req.param("id"));
			const rows = Number.isSafeInteger(id)
				? db
						.delete(fileGrants)
						.where(
							and(
								eq(fileGrants.folderId, id),
								eq(fileGrants.userId, c.req.param("userId")),
							),
						)
						.returning({ userId: fileGrants.userId })
						.all()
				: [];
			if (rows.length === 0) return c.json({ error: "not found" }, 404);
			return c.json({ ok: true });
		},
	);

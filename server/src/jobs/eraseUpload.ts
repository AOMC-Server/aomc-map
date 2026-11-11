import { floorDiv } from "@aomc/shared";
import { and, asc, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm";
import {
	jobs,
	mapInfo,
	revisions,
	tileVersions,
	uploadPatches,
} from "../db/schema";
import { loadMap } from "../permissions";
import {
	composeParent,
	emptyTile,
	loadTile,
	overRegion,
	storeTile,
} from "../tiles/compose";
import {
	stackOrder,
	type TilePatch,
	tileHashAt,
	tilePatches,
} from "../tiles/history";
import { parseKey, tileKey } from "../tiles/pyramid";
import { type EraseUploadPayload, type JobContext, UserError } from "./types";

type Row = { rev: number; hash: string | null };

const sameRows = (a: Row[], b: Row[]) =>
	a.length === b.length &&
	a.every((r, i) => r.rev === b[i]?.rev && r.hash === b[i]?.hash);

/**
 * Deletes an upload as if it had never been made: it leaves the map, every past revision, the
 * upload log and the job history. No other upload changes, and the others keep their revision
 * numbers (there is just a gap, or the head moves back when the last revision was deleted).
 *
 * Only the tiles the upload touched are rewritten, and only from its revision onwards: for each
 * one, the content at every later revision is replayed without the upload, and a row is stored
 * wherever that differs from the revision before. The zoomed-out tiles above are rebuilt from
 * the rewritten rows the same way. Everything is swapped in with one transaction.
 */
export async function eraseUpload(
	ctx: JobContext,
	payload: EraseUploadPayload,
) {
	const { db, env, blobs, progress } = ctx;
	const say = (message: string, done?: number, total?: number) =>
		progress.emit(payload.revisionId, {
			status: "processing",
			message,
			done,
			total,
		});

	const [target] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, payload.revisionId));
	if (
		target?.kind !== "upload" ||
		target.rev === null ||
		target.dimensionId === null
	) {
		throw new UserError("target revision is not a finished upload");
	}
	const R = target.rev;
	const dimId = target.dimensionId;
	const T = (await loadMap(db)).tileSize;

	// The upload and any revert or restore that was made of it.
	const removed = new Set<number>([target.id]);
	for (const op of await db
		.select({ id: revisions.id })
		.from(revisions)
		.where(eq(revisions.targetRevisionId, target.id))) {
		removed.add(op.id);
	}

	// What happened to this dimension, in order: which uploads were live is replayed from this.
	const timeline = await db
		.select({
			id: revisions.id,
			rev: revisions.rev,
			kind: revisions.kind,
			target: revisions.targetRevisionId,
		})
		.from(revisions)
		.where(
			and(
				eq(revisions.dimensionId, dimId),
				eq(revisions.status, "done"),
				isNotNull(revisions.rev),
			),
		)
		.orderBy(asc(revisions.rev));

	const oldRows = async (zoom: number, x: number, y: number): Promise<Row[]> =>
		(
			await db
				.select({ rev: tileVersions.rev, hash: tileVersions.blobHash })
				.from(tileVersions)
				.where(
					and(
						eq(tileVersions.dimensionId, dimId),
						eq(tileVersions.zoom, zoom),
						eq(tileVersions.tileX, x),
						eq(tileVersions.tileY, y),
						gte(tileVersions.rev, R),
					),
				)
				.orderBy(asc(tileVersions.rev))
		).map((r) => ({ rev: r.rev, hash: r.hash }));

	/** The tile as of just before the upload, which the erase does not change. */
	const baseCache = new Map<string, string | null>();
	const baseHash = async (zoom: number, x: number, y: number) => {
		const key = `${zoom}:${x},${y}`;
		if (!baseCache.has(key)) {
			baseCache.set(key, await tileHashAt(db, dimId, zoom, x, y, R - 1));
		}
		return baseCache.get(key) ?? null;
	};

	const rewrites: { zoom: number; x: number; y: number; rows: Row[] }[] = [];

	// Zoom 0: replay each touched tile without the upload.
	const touched = await db
		.select({ x: uploadPatches.tileX, y: uploadPatches.tileY })
		.from(uploadPatches)
		.where(eq(uploadPatches.revisionId, target.id));

	let level = new Map<string, Row[]>();
	let n = 0;
	for (const { x, y } of touched) {
		const patches = new Map(
			(await tilePatches(db, dimId, x, y))
				.filter((p) => p.id !== target.id)
				.map((p) => [p.id, p]),
		);
		const live = new Set<number>();
		const hashes = new Map<string, string | null>();
		// The composite of the stack `held`, so a patch landing on top costs one decode, not all of them.
		let canvas = emptyTile(T);
		let held: TilePatch[] = [];
		const contentHash = async () => {
			const stack = [...live]
				.map((id) => patches.get(id))
				.filter((p) => p !== undefined)
				.sort(stackOrder);
			const key = stack.map((p) => p.id).join(",");
			if (!hashes.has(key)) {
				if (!held.every((p, i) => p === stack[i])) {
					canvas = emptyTile(T);
					held = [];
				}
				for (const p of stack.slice(held.length)) {
					overRegion(canvas, T, await loadTile(blobs, p.hash, T), T, T, 0, 0);
				}
				held = stack;
				hashes.set(key, await storeTile(blobs, canvas, T));
			}
			return hashes.get(key) ?? null;
		};

		let prev = await baseHash(0, x, y);
		const rows: Row[] = [];
		for (const e of timeline) {
			if (removed.has(e.id) || e.rev === null) continue;
			const subject = e.kind === "upload" ? e.id : (e.target ?? -1);
			if (!patches.has(subject)) continue;
			if (e.kind === "revert") live.delete(subject);
			else live.add(subject);
			if (e.rev < R) continue;
			const hash = await contentHash();
			if (hash !== prev) {
				rows.push({ rev: e.rev, hash });
				prev = hash;
			}
		}
		if (!sameRows(rows, await oldRows(0, x, y))) {
			rewrites.push({ zoom: 0, x, y, rows });
			level.set(tileKey(x, y), rows);
		}
		say("rewriting tiles", ++n, touched.length);
	}

	// Zoomed out: each parent follows its four children, wherever any of them changes.
	for (let zoom = 1; zoom <= env.MAX_ZOOM && level.size > 0; zoom++) {
		const parents = new Set<string>();
		for (const key of level.keys()) {
			const [x, y] = parseKey(key);
			parents.add(tileKey(floorDiv(x, 2), floorDiv(y, 2)));
		}

		const next = new Map<string, Row[]>();
		const mixes = new Map<string, string | null>();
		for (const parentKey of parents) {
			const [px, py] = parseKey(parentKey);
			const kids = await Promise.all(
				[0, 1, 2, 3].map(async (q) => {
					const cx = 2 * px + (q % 2);
					const cy = 2 * py + Math.floor(q / 2);
					return {
						base: await baseHash(zoom - 1, cx, cy),
						rows:
							level.get(tileKey(cx, cy)) ?? (await oldRows(zoom - 1, cx, cy)),
					};
				}),
			);
			const revs = [
				...new Set(kids.flatMap((k) => k.rows.map((r) => r.rev))),
			].sort((a, b) => a - b);

			let prev = await baseHash(zoom, px, py);
			const rows: Row[] = [];
			for (const rev of revs) {
				const hashes = kids.map((k) => {
					const row = k.rows.findLast((r) => r.rev <= rev);
					return row ? row.hash : k.base;
				});
				const mixKey = hashes.join("|");
				if (!mixes.has(mixKey)) {
					const canvas = composeParent(
						T,
						await Promise.all(
							hashes.map((hash) => (hash ? loadTile(blobs, hash, T) : null)),
						),
					);
					mixes.set(mixKey, canvas ? await storeTile(blobs, canvas, T) : null);
				}
				const hash = mixes.get(mixKey) ?? null;
				if (hash !== prev) {
					rows.push({ rev, hash });
					prev = hash;
				}
			}
			if (!sameRows(rows, await oldRows(zoom, px, py))) {
				rewrites.push({ zoom, x: px, y: py, rows });
				next.set(parentKey, rows);
			}
		}
		level = next;
		say(`rebuilding zoom level ${zoom}`);
	}

	say("publishing");
	const ids = [...removed];
	db.transaction((tx) => {
		for (const w of rewrites) {
			tx.delete(tileVersions)
				.where(
					and(
						eq(tileVersions.dimensionId, dimId),
						eq(tileVersions.zoom, w.zoom),
						eq(tileVersions.tileX, w.x),
						eq(tileVersions.tileY, w.y),
						gte(tileVersions.rev, R),
					),
				)
				.run();
		}
		const inserts = rewrites.flatMap((w) =>
			w.rows.map((r) => ({
				dimensionId: dimId,
				zoom: w.zoom,
				tileX: w.x,
				tileY: w.y,
				rev: r.rev,
				blobHash: r.hash,
			})),
		);
		for (let i = 0; i < inserts.length; i += 500) {
			tx.insert(tileVersions)
				.values(inserts.slice(i, i + 500))
				.run();
		}

		tx.delete(uploadPatches)
			.where(inArray(uploadPatches.revisionId, ids))
			.run();
		tx.delete(jobs)
			.where(inArray(sql`json_extract(${jobs.payload}, '$.revisionId')`, ids))
			.run();
		tx.delete(revisions).where(inArray(revisions.id, ids)).run();

		// If the deleted revisions were the newest, the head moves back to the newest one left.
		const newest = tx
			.select({ rev: max(revisions.rev) })
			.from(revisions)
			.get();
		tx.update(mapInfo)
			.set({
				headRev: newest?.rev ?? 0,
				epoch: sql`${mapInfo.epoch} + 1`,
			})
			.run();
	});
}

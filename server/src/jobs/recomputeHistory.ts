import { floorDiv } from "@aomc/shared";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { mapLimit } from "../concurrency";
import type { Db } from "../db/client";
import {
	dimensions,
	jobs,
	mapInfo,
	revisions,
	tileVersions,
	tileVersionsRebuild,
	uploadPatches,
} from "../db/schema";
import { loadMap } from "../permissions";
import { loadTile, overRegion, storeTile } from "../tiles/compose";
import { effectiveTime } from "../tiles/history";
import { parseKey, tileKey } from "../tiles/pyramid";
import { parentRows, type Row } from "../tiles/rows";
import { messages } from "./messages";
import type { JobContext } from "./types";

export type RecomputeProgress = {
	message: string;
	done?: number;
	total?: number;
};

const FLUSH_ROWS = 2000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const doneUploads = (db: Db | Tx) =>
	db
		.select({
			id: revisions.id,
			rev: revisions.rev,
			dimensionId: revisions.dimensionId,
			at: effectiveTime,
		})
		.from(revisions)
		.where(
			and(
				eq(revisions.kind, "upload"),
				eq(revisions.status, "done"),
				isNotNull(revisions.rev),
			),
		)
		.orderBy(asc(effectiveTime), asc(revisions.id))
		.all();

/**
 * How many finished uploads were published after an upload of the same dimension that was
 * exported later (the ones the history panel marks "late"). Looking at the map as of one of
 * them also shows those newer exports.
 */
export function lateUploads(db: Db): number {
	const byRev = doneUploads(db).sort(
		(a, b) => (a.rev as number) - (b.rev as number),
	);
	const latest = new Map<number | null, number>();
	let late = 0;
	for (const u of byRev) {
		const before = latest.get(u.dimensionId) ?? Number.NEGATIVE_INFINITY;
		if (u.at < before) late++;
		latest.set(u.dimensionId, Math.max(before, u.at));
	}
	return late;
}

/** The newest recompute job, if any. */
export const lastRecompute = (db: Db) =>
	db
		.select()
		.from(jobs)
		.where(eq(jobs.type, "recompute_history"))
		.orderBy(desc(jobs.id))
		.limit(1)
		.get();

/** Queues a recompute unless one is already queued or running. Returns whether it queued one. */
export function queueRecompute(db: Db): boolean {
	return db.transaction((tx) => {
		const busy = tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.type, "recompute_history"),
					inArray(jobs.status, ["pending", "processing"]),
				),
			)
			.get();
		if (busy) return false;
		tx.insert(jobs).values({ type: "recompute_history", payload: {} }).run();
		return true;
	});
}

/** On boot: queues the recompute a migration asked for (see map_info.recompute_pending). */
export function queueRecomputeIfPending(db: Db): boolean {
	const map = db
		.select({ pending: mapInfo.recomputePending })
		.from(mapInfo)
		.get();
	return map?.pending ? queueRecompute(db) : false;
}

/**
 * Rebuilds the whole history in export order. Every finished upload gets a new revision number,
 * 1 to N, ordered by when it was exported (upload order breaking ties) across all dimensions, and
 * every tile version is rebuilt from the uploads' patches in that order. So the map at revision
 * k holds exactly the k oldest exports, and nothing published "late" shows up before its time.
 * The newest state of the map stays the same, since tiles are always stacked in export order.
 *
 * The new rows are written to tile_versions_rebuild and swapped in, together with the new
 * revision numbers, in one transaction that also marks the job done. Until then nothing visible
 * changes, so an interrupted run leaves the old history in place.
 */
export async function recomputeHistory(
	ctx: JobContext,
	jobId: number,
	say: (p: RecomputeProgress) => void = () => {},
) {
	const { db, env, blobs } = ctx;
	const map = await loadMap(db);
	const T = map.tileSize;
	const startHead = map.headRev;

	const uploads = doneUploads(db);
	const newRev = new Map(uploads.map((u, i) => [u.id, i + 1]));

	db.delete(tileVersionsRebuild).run();
	let pending: (typeof tileVersionsRebuild.$inferInsert)[] = [];
	const flush = () => {
		if (pending.length === 0) return;
		const chunk = pending;
		pending = [];
		db.transaction((tx) => {
			for (let i = 0; i < chunk.length; i += 500) {
				tx.insert(tileVersionsRebuild)
					.values(chunk.slice(i, i + 500))
					.run();
			}
		});
	};
	const write = (
		dimensionId: number,
		zoom: number,
		x: number,
		y: number,
		rows: Row[],
	) => {
		for (const r of rows) {
			pending.push({
				dimensionId,
				zoom,
				tileX: x,
				tileY: y,
				rev: r.rev,
				blobHash: r.hash,
			});
		}
		if (pending.length >= FLUSH_ROWS) flush();
	};

	const dimIds = [
		...new Set(
			uploads.flatMap((u) => (u.dimensionId === null ? [] : [u.dimensionId])),
		),
	];
	const names = new Map(
		db
			.select({ id: dimensions.id, name: dimensions.name })
			.from(dimensions)
			.all()
			.map((d) => [d.id, d.name]),
	);

	for (const [dimIndex, dimId] of dimIds.entries()) {
		const dimNo = dimIndex + 1;
		const name = names.get(dimId) ?? `dimension ${dimId}`;
		const patches = db
			.select({
				id: uploadPatches.revisionId,
				x: uploadPatches.tileX,
				y: uploadPatches.tileY,
				hash: uploadPatches.blobHash,
			})
			.from(uploadPatches)
			.innerJoin(revisions, eq(revisions.id, uploadPatches.revisionId))
			.where(
				and(
					eq(revisions.dimensionId, dimId),
					eq(revisions.kind, "upload"),
					eq(revisions.status, "done"),
					isNotNull(revisions.rev),
				),
			)
			.all();
		const byTile = new Map<string, { rev: number; hash: string }[]>();
		for (const p of patches) {
			const rev = newRev.get(p.id);
			if (rev === undefined) continue;
			const key = tileKey(p.x, p.y);
			const list = byTile.get(key) ?? [];
			list.push({ rev, hash: p.hash });
			byTile.set(key, list);
		}

		// Zoom 0: each tile is its patches stacked in the new order, a version per change.
		let level = new Map<string, Row[]>();
		let n = 0;
		await mapLimit([...byTile], env.JOB_CONCURRENCY, async ([key, list]) => {
			list.sort((a, b) => a.rev - b.rev);
			// The first patch lands on an empty tile, so the tile is that patch as it is stored.
			const first = list[0] as (typeof list)[number];
			const rows: Row[] = [{ rev: first.rev, hash: first.hash }];
			if (list.length > 1) {
				const canvas = await loadTile(blobs, first.hash, T);
				let prev: string | null = first.hash;
				for (const p of list.slice(1)) {
					overRegion(canvas, T, await loadTile(blobs, p.hash, T), T, T, 0, 0);
					const hash = await storeTile(blobs, canvas, T);
					if (hash !== prev) {
						rows.push({ rev: p.rev, hash });
						prev = hash;
					}
				}
			}
			const [x, y] = parseKey(key);
			write(dimId, 0, x, y, rows);
			level.set(key, rows);
			say({
				message: messages.recompute.tiles(name, dimNo, dimIds.length),
				done: ++n,
				total: byTile.size,
			});
		});

		// Zoomed out: each parent follows its four children.
		for (let zoom = 1; zoom <= env.MAX_ZOOM && level.size > 0; zoom++) {
			const parents = new Set<string>();
			for (const key of level.keys()) {
				const [x, y] = parseKey(key);
				parents.add(tileKey(floorDiv(x, 2), floorDiv(y, 2)));
			}
			const next = new Map<string, Row[]>();
			const mixes = new Map<string, string | null>();
			n = 0;
			await mapLimit([...parents], env.JOB_CONCURRENCY, async (parentKey) => {
				const [px, py] = parseKey(parentKey);
				const kids = [0, 1, 2, 3].map((q) => ({
					base: null,
					rows:
						level.get(tileKey(2 * px + (q % 2), 2 * py + Math.floor(q / 2))) ??
						[],
				}));
				const rows = await parentRows({
					blobs,
					tileSize: T,
					kids,
					base: null,
					mixes,
				});
				if (rows.length > 0) {
					write(dimId, zoom, px, py, rows);
					next.set(parentKey, rows);
				}
				say({
					message: messages.recompute.zoom(name, zoom),
					done: ++n,
					total: parents.size,
				});
			});
			level = next;
		}
	}
	flush();

	say({ message: messages.recompute.publishing });
	db.transaction((tx) => {
		// Only the worker publishes or deletes uploads, and it runs one job at a time; this guards
		// against that ever changing.
		const head = tx.select({ headRev: mapInfo.headRev }).from(mapInfo).get();
		const now = doneUploads(tx);
		if (
			head?.headRev !== startHead ||
			now.length !== uploads.length ||
			now.some((u) => !newRev.has(u.id))
		) {
			throw new Error("the map changed during the recompute");
		}

		tx.delete(tileVersions).run();
		tx.run(sql`INSERT INTO tile_versions (dimension_id, zoom, tile_x, tile_y, rev, blob_hash)
			SELECT dimension_id, zoom, tile_x, tile_y, rev, blob_hash FROM tile_versions_rebuild`);
		tx.delete(tileVersionsRebuild).run();

		// Revision numbers are unique, so they are moved out of the way before being reassigned.
		tx.update(revisions)
			.set({ rev: sql`-${revisions.rev}` })
			.where(isNotNull(revisions.rev))
			.run();
		for (const [id, rev] of newRev) {
			tx.update(revisions).set({ rev }).where(eq(revisions.id, id)).run();
		}

		tx.update(mapInfo)
			.set({
				headRev: uploads.length,
				epoch: sql`${mapInfo.epoch} + 1`,
				recomputePending: false,
			})
			.run();
		tx.update(jobs)
			.set({ status: "done", error: null, completedAt: Date.now() })
			.where(eq(jobs.id, jobId))
			.run();
	});
}

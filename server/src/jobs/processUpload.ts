import { floorDiv } from "@aomc/shared";
import { eq } from "drizzle-orm";
import { dimensions, revisions } from "../db/schema";
import { loadMap } from "../permissions";
import {
	decodeRaw,
	emptyTile,
	loadTile,
	overRegion,
	storeTile,
} from "../tiles/compose";
import {
	type Bbox,
	commitRevision,
	tileHashAt,
	tilePatches,
} from "../tiles/history";
import { buildPyramid, type TileWrite, tileKey } from "../tiles/pyramid";
import { blackToAlpha } from "../tiles/xaero";
import {
	incomingDir,
	type JobContext,
	type ProcessUploadPayload,
} from "./types";

export async function processUpload(
	ctx: JobContext,
	payload: ProcessUploadPayload,
) {
	const { db, env, blobs, progress } = ctx;
	const { revisionId, files } = payload;
	const say = (message: string, done?: number, total?: number) =>
		progress.emit(revisionId, { status: "processing", message, done, total });

	const [revision] = await db
		.select()
		.from(revisions)
		.where(eq(revisions.id, revisionId));
	if (!revision || revision.dimensionId === null)
		throw new Error("revision not found");
	const map = await loadMap(db);
	const [dim] = await db
		.select()
		.from(dimensions)
		.where(eq(dimensions.id, revision.dimensionId));
	if (!dim) throw new Error("dimension not found");
	const T = map.tileSize;
	const head = map.headRev;

	// Which files touch which zoom 0 tile (tile_y indexes the z axis).
	const byTile = new Map<string, { tx: number; ty: number; files: number[] }>();
	files.forEach((f, index) => {
		for (
			let ty = floorDiv(f.z, T);
			ty <= floorDiv(f.z + f.height - 1, T);
			ty++
		) {
			for (
				let tx = floorDiv(f.x, T);
				tx <= floorDiv(f.x + f.width - 1, T);
				tx++
			) {
				const key = tileKey(tx, ty);
				const entry = byTile.get(key) ?? { tx, ty, files: [] };
				entry.files.push(index);
				byTile.set(key, entry);
			}
		}
	});

	// One patch per touched tile, files pasted in upload order. Done tile by tile to bound memory.
	const patches: { x: number; y: number; hash: string }[] = [];
	let n = 0;
	for (const { tx, ty, files: indexes } of byTile.values()) {
		const canvas = emptyTile(T);
		for (const index of indexes) {
			const f = files[index] as (typeof files)[number];
			const img = await decodeRaw(
				`${incomingDir(env, revisionId)}/${index}.png`,
			);
			blackToAlpha(img.data);
			overRegion(
				canvas,
				T,
				img.data,
				img.width,
				img.height,
				f.x - tx * T,
				f.z - ty * T,
			);
		}
		const hash = await storeTile(blobs, canvas, T);
		if (hash) patches.push({ x: tx, y: ty, hash });
		say("building patches", ++n, byTile.size);
	}
	if (patches.length === 0) throw new Error("upload contains no map data");

	// Composite each patch into its tile. Normally that is over the tile as of the current head;
	// but if an export made later than this one already covers the tile, this (older) export
	// goes underneath it, so the tile is replayed from every patch in export order.
	const exportedAt = revision.exportedAt ?? revision.createdAt;
	const changed = new Map<string, string | null>();
	const writes: TileWrite[] = [];
	n = 0;
	for (const p of patches) {
		const current = await tileHashAt(db, dim.id, 0, p.x, p.y, head);
		const live = (await tilePatches(db, dim.id, p.x, p.y)).filter(
			(q) => !q.reverted,
		);
		let canvas: Buffer;
		if (live.some((q) => q.at > exportedAt)) {
			const stack = [...live, { id: revisionId, at: exportedAt, hash: p.hash }];
			stack.sort((a, b) => a.at - b.at || a.id - b.id);
			canvas = emptyTile(T);
			for (const q of stack) {
				overRegion(canvas, T, await loadTile(blobs, q.hash, T), T, T, 0, 0);
			}
		} else {
			canvas = current ? await loadTile(blobs, current, T) : emptyTile(T);
			overRegion(canvas, T, await loadTile(blobs, p.hash, T), T, T, 0, 0);
		}
		const hash = await storeTile(blobs, canvas, T);
		if (hash !== current) {
			changed.set(tileKey(p.x, p.y), hash);
			writes.push({ zoom: 0, x: p.x, y: p.y, hash });
		}
		say("compositing tiles", ++n, patches.length);
	}

	say("building zoom levels");
	writes.push(
		...(await buildPyramid({
			blobs,
			tileSize: T,
			maxZoom: env.MAX_ZOOM,
			changed,
			current: (zoom, x, y) => tileHashAt(db, dim.id, zoom, x, y, head),
		})),
	);

	const bbox: Bbox = {
		minX: Math.min(...files.map((f) => f.x)),
		minZ: Math.min(...files.map((f) => f.z)),
		maxX: Math.max(...files.map((f) => f.x + f.width - 1)),
		maxZ: Math.max(...files.map((f) => f.z + f.height - 1)),
	};
	say("publishing");
	commitRevision(db, {
		revisionId,
		rev: head + 1,
		dimensionId: dim.id,
		writes,
		patches,
		bbox,
	});
}

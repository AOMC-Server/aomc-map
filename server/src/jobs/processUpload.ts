import { floorDiv } from "@aomc/shared";
import { eq } from "drizzle-orm";
import { dimensions, maps, revisions } from "../db/schema";
import {
	decodeRaw,
	emptyTile,
	loadTile,
	overRegion,
	storeTile,
} from "../tiles/compose";
import { type Bbox, commitRevision, tileHashAt } from "../tiles/history";
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
	const [map] = await db.select().from(maps).where(eq(maps.id, revision.mapId));
	if (!map) throw new Error("map not found");
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

	// Composite each patch over the tile as of the current head.
	const changed = new Map<string, string | null>();
	const writes: TileWrite[] = [];
	n = 0;
	for (const p of patches) {
		const current = await tileHashAt(db, dim.id, 0, p.x, p.y, head);
		const canvas = current ? await loadTile(blobs, current, T) : emptyTile(T);
		overRegion(canvas, T, await loadTile(blobs, p.hash, T), T, T, 0, 0);
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
		mapId: map.id,
		revisionId,
		rev: head + 1,
		dimensionId: dim.id,
		writes,
		patches,
		bbox,
	});
}

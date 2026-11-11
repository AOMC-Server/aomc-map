import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createSession } from "../src/auth/session";
import { createApiToken } from "../src/auth/tokens";
import { createDb, runMigrations } from "../src/db/client";
import { users } from "../src/db/schema";
import { parseEnv } from "../src/env";
import { createServices } from "../src/services";

export function makeTestApp(
	envOverrides: Record<string, string> = {},
	fetchFn?: typeof fetch,
) {
	const dir = mkdtempSync(join(tmpdir(), "aomc-test-"));
	const db = createDb(join(dir, "db.sqlite"));
	runMigrations(db);
	const env = parseEnv({
		DATA_DIR: dir,
		PUBLIC_URL: "http://localhost:3000",
		...envOverrides,
	});
	const services = createServices(db, env);
	const app = createApp({ db, env, services, fetch: fetchFn });
	return { app, db, env, services };
}

export async function makeUser(
	db: ReturnType<typeof createDb>,
	id: string,
	username = id,
) {
	await db.insert(users).values({ id, username, lastLoginAt: Date.now() });
	const { token } = await createApiToken(db, id, "test");
	return { id, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeSessionCookie(
	db: ReturnType<typeof createDb>,
	userId: string,
) {
	return `aomc_session=${await createSession(db, userId)}`;
}

export const json = (body: unknown) => ({
	body: JSON.stringify(body),
	headers: { "Content-Type": "application/json" },
});

import sharp from "sharp";
import { mapMembers, maps } from "../src/db/schema";
import { runSetup } from "../src/setup";

export type Rgb = [number, number, number];

/** PNG built from a per-pixel function. */
export function png(
	w: number,
	h: number,
	pixel: (x: number, y: number) => Rgb,
) {
	const raw = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) raw.set(pixel(x, y), (y * w + x) * 3);
	}
	return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
		.png()
		.toBuffer();
}

/** Decodes an image to raw RGBA (for tests that live outside the server package). */
export async function decodeRgba(data: Uint8Array) {
	const { data: raw, info } = await sharp(data)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data: raw, width: info.width, height: info.height };
}

export const solid = (w: number, h: number, c: Rgb) => png(w, h, () => c);

export const RED: Rgb = [255, 0, 0];
export const GREEN: Rgb = [0, 255, 0];
export const BLUE: Rgb = [0, 0, 255];
export const BLACK: Rgb = [0, 0, 0];

export const T = 16;

/** A booted app with a 16px-tile default map, plus users with various roles. */
export async function bootTiles(extraEnv: Record<string, string> = {}) {
	const t = makeTestApp({
		DEFAULT_TILE_SIZE: String(T),
		MAX_ZOOM: "3",
		...extraEnv,
	});
	await runSetup(t.db, t.env);
	const [map] = await t.db.select().from(maps);
	const mapId = (map as { id: number }).id;
	const editor = await makeUser(t.db, "editor");
	const mod = await makeUser(t.db, "mod");
	await t.db
		.insert(mapMembers)
		.values({ mapId, userId: "mod", role: "moderator" });
	return { ...t, mapId, editor, mod };
}
export type TileApp = Awaited<ReturnType<typeof bootTiles>>;

export type UploadFileSpec = {
	name: string;
	data: Uint8Array | Buffer;
	coords?: { x: number; z: number };
};

export async function postUpload(
	t: TileApp,
	user: { auth: Record<string, string> } | null,
	files: UploadFileSpec[],
	opts: {
		dim?: string;
		coords?: { x: number; z: number }[];
		field?: string;
	} = {},
) {
	const form = new FormData();
	for (const f of files) {
		form.append(
			opts.field ?? "files[]",
			new File([f.data as BlobPart], f.name),
		);
	}
	if (opts.coords) form.append("coords", JSON.stringify(opts.coords));
	return t.app.request(
		`/api/maps/aomc/dimensions/${opts.dim ?? "overworld"}/uploads`,
		{
			method: "POST",
			body: form,
			headers: user?.auth ?? {},
		},
	);
}

/** Uploads one image at block coordinates and waits for the worker. Returns the revision id. */
export async function upload(
	t: TileApp,
	data: Uint8Array | Buffer,
	x: number,
	z: number,
	user: { auth: Record<string, string> } = t.editor,
	dim = "overworld",
) {
	return uploadMany(t, [{ data, x, z }], user, dim);
}

export async function uploadMany(
	t: TileApp,
	items: { data: Uint8Array | Buffer; x: number; z: number }[],
	user: { auth: Record<string, string> } = t.editor,
	dim = "overworld",
) {
	const res = await postUpload(
		t,
		user,
		items.map((it, i) => ({ name: `f${i}.png`, data: it.data })),
		{ dim, coords: items.map((it) => ({ x: it.x, z: it.z })) },
	);
	if (res.status !== 202)
		throw new Error(`upload failed: ${res.status} ${await res.text()}`);
	const { revisionId } = (await res.json()) as { revisionId: number };
	await t.services.worker.run();
	return revisionId;
}

export async function revisionOf(t: TileApp, id: number) {
	const res = await t.app.request(`/api/revisions/${id}`);
	return ((await res.json()) as { revision: Record<string, unknown> }).revision;
}

export async function revert(
	t: TileApp,
	id: number,
	kind: "revert" | "unrevert" = "revert",
	user: { auth: Record<string, string> } = t.mod,
) {
	const res = await t.app.request(`/api/revisions/${id}/${kind}`, {
		method: "POST",
		headers: user.auth,
	});
	if (res.status !== 202)
		throw new Error(`${kind} failed: ${res.status} ${await res.text()}`);
	await t.services.worker.run();
	return ((await res.json()) as { revisionId: number }).revisionId;
}

/** Fetches a tile as raw RGBA, following the redirect. null = 204 (empty). */
export async function readTile(
	t: TileApp,
	zoom: number,
	x: number,
	y: number,
	rev?: number,
	dim = "overworld",
): Promise<Buffer | null> {
	const q = rev === undefined ? "" : `?rev=${rev}`;
	const res = await t.app.request(
		`/api/maps/aomc/dimensions/${dim}/tiles/${zoom}/${x}/${y}${q}`,
	);
	if (res.status === 204) return null;
	if (res.status !== 302)
		throw new Error(`tile fetch: ${res.status} ${await res.text()}`);
	const blob = await t.app.request(res.headers.get("location") as string);
	const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer()))
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	if (info.width !== T || info.height !== T)
		throw new Error("unexpected tile size");
	return data;
}

export const px = (tile: Buffer, x: number, y: number) => [
	...tile.subarray((y * T + x) * 4, (y * T + x) * 4 + 4),
];

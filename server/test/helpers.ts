import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../src/app";
import { createSession } from "../src/auth/session";
import { createApiToken } from "../src/auth/tokens";
import { createDb, runMigrations } from "../src/db/client";
import { members, users } from "../src/db/schema";
import { parseEnv } from "../src/env";
import { createServices } from "../src/services";
import { runSetup } from "../src/setup";

const tempDirs: string[] = [];
/** Removes every temp dir made so far. Register with `afterAll` in each test file that boots apps. */
export function cleanupTempDirs() {
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

// Module-level hooks only cover the first file that imports this module (bun test shares it).
afterAll(cleanupTempDirs);

/** A temp directory that is removed by `cleanupTempDirs`. */
export function makeTempDir(prefix = "aomc-test-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

export function makeTestApp(
	envOverrides: Record<string, string> = {},
	fetchFn?: typeof fetch,
) {
	const dir = makeTempDir();
	const db = createDb(join(dir, "db.sqlite"));
	runMigrations(db);
	const env = parseEnv({
		DATA_DIR: dir,
		PUBLIC_URL: "http://localhost:3000",
		...envOverrides,
	});
	runSetup(db, env);
	const services = createServices(db, env);
	const app = createApp({ db, env, services, fetch: fetchFn });
	return { app, db, env, services };
}

type Db = ReturnType<typeof createDb>;

export async function makeUser(db: Db, id: string, username = id) {
	await db.insert(users).values({ id, username, lastLoginAt: Date.now() });
	const { token } = await createApiToken(db, id, "test");
	return { id, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeSessionCookie(db: Db, userId: string) {
	return `aomc_session=${await createSession(db, userId)}`;
}

export const json = (body: unknown) => ({
	body: JSON.stringify(body),
	headers: { "Content-Type": "application/json" },
});

export async function addMember(
	t: { db: Db },
	userId: string,
	role: "moderator" | "owner",
) {
	await t.db.insert(members).values({ userId, role });
}

export type Auth = { auth: Record<string, string> } | null;

/** Sends a request as `user` (null = anonymous); the body is JSON and the response parsed. */
export async function call(
	t: { app: ReturnType<typeof createApp> },
	user: Auth,
	method: string,
	path: string,
	body?: unknown,
) {
	const headers: Record<string, string> = { ...(user?.auth ?? {}) };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await t.app.request(path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return {
		status: res.status,
		// biome-ignore lint/suspicious/noExplicitAny: test responses are inspected loosely
		body: (text ? JSON.parse(text) : null) as any,
		headers: res.headers,
	};
}

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

/** Decodes an image to raw RGBA. Also used by the scripts tests. */
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

/** A booted app with a 16px-tile map, an `editor` and a moderator `mod` (and an `owner` on request). */
export async function bootTiles(
	extraEnv: Record<string, string> = {},
	opts: { owner?: boolean } = {},
) {
	const t = makeTestApp({
		DEFAULT_TILE_SIZE: String(T),
		MAX_ZOOM: "3",
		...extraEnv,
	});
	const editor = await makeUser(t.db, "editor");
	const mod = await makeUser(t.db, "mod");
	await addMember(t, "mod", "moderator");
	let owner: Awaited<ReturnType<typeof makeUser>> | undefined;
	if (opts.owner) {
		owner = await makeUser(t.db, "owner");
		await addMember(t, "owner", "owner");
	}
	return { ...t, editor, mod, owner: owner as NonNullable<typeof owner> };
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
		paths?: string[];
		field?: string;
		headers?: Record<string, string>;
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
	if (opts.paths) form.append("paths", JSON.stringify(opts.paths));
	return t.app.request(`/api/dimensions/${opts.dim ?? "overworld"}/uploads`, {
		method: "POST",
		body: form,
		headers: { ...(user?.auth ?? {}), ...opts.headers },
	});
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
	items: {
		data: Uint8Array | Buffer;
		x: number;
		z: number;
		/** Where the file came from, e.g. "2026-02-10_15.06.41/0_0.png"; its date is the export date. */
		path?: string;
	}[],
	user: { auth: Record<string, string> } = t.editor,
	dim = "overworld",
) {
	const res = await postUpload(
		t,
		user,
		items.map((it, i) => ({ name: `f${i}.png`, data: it.data })),
		{
			dim,
			coords: items.map((it) => ({ x: it.x, z: it.z })),
			paths: items.some((it) => it.path)
				? items.map((it, i) => it.path ?? `f${i}.png`)
				: undefined,
		},
	);
	if (res.status !== 202)
		throw new Error(`upload failed: ${res.status} ${await res.text()}`);
	const { revisionId } = (await res.json()) as { revisionId: number };
	await t.services.worker.run();
	return revisionId;
}

/** Uploads one image that came from `path` (its name or folder carries the export date). */
export const uploadFrom = (
	t: TileApp,
	data: Uint8Array | Buffer,
	x: number,
	z: number,
	path: string,
) => uploadMany(t, [{ data, x, z, path }]);

export async function revisionOf(t: TileApp, id: number) {
	const res = await t.app.request(`/api/revisions/${id}`);
	return ((await res.json()) as { revision: Record<string, unknown> }).revision;
}

/** Deletes an upload (as a moderator unless told otherwise) and waits for the erase job. */
export async function erase(
	t: TileApp,
	id: number,
	user: { auth: Record<string, string> } = t.mod,
) {
	const res = await t.app.request(`/api/revisions/${id}`, {
		method: "DELETE",
		headers: user.auth,
	});
	if (res.status !== 202)
		throw new Error(`erase failed: ${res.status} ${await res.text()}`);
	await t.services.worker.run();
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
		`/api/dimensions/${dim}/tiles/${zoom}/${x}/${y}${q}`,
	);
	if (res.status === 204) return null;
	if (res.status !== 302)
		throw new Error(`tile fetch: ${res.status} ${await res.text()}`);
	const blob = await t.app.request(res.headers.get("location") as string);
	const { data, width, height } = await decodeRgba(
		new Uint8Array(await blob.arrayBuffer()),
	);
	if (width !== T || height !== T) throw new Error("unexpected tile size");
	return data;
}

export const px = (tile: Buffer, x: number, y: number) => [
	...tile.subarray((y * T + x) * 4, (y * T + x) * 4 + 4),
];

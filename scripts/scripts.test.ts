import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { blobFiles, jobs, storageHistory } from "../server/src/db/schema";
import {
	bootTiles,
	cleanupTempDirs,
	decodeRgba,
	makeTempDir,
	makeTestApp,
	makeUser,
	png,
	RED,
	solid,
	upload,
} from "../server/test/helpers";
import { backup } from "./backup";
import { gcBlobs } from "./gc-blobs";
import { runImport } from "./import-v1";

afterAll(cleanupTempDirs);

const tmp = (name: string) => makeTempDir(`aomc-${name}-`);

describe("backup", () => {
	async function withData() {
		const t = await bootTiles();
		await upload(t, await solid(16, 16, RED), 0, 0);
		return t;
	}

	test("snapshots the database and copies blobs; running again only adds what is new", async () => {
		const t = await withData();
		const dest = tmp("backup");
		const first = await backup({
			dataDir: t.env.DATA_DIR,
			dest,
			now: new Date(Date.UTC(2026, 10, 10, 12, 0, 0)),
		});
		expect(first.snapshot).toEndWith("db-20261110T120000000Z.sqlite");
		expect(first.blobsCopied).toBeGreaterThan(0);

		// The snapshot is a complete, readable database.
		const snap = new Database(first.snapshot, { readonly: true });
		expect(
			(
				snap.query("SELECT COUNT(*) AS n FROM tile_versions").get() as {
					n: number;
				}
			).n,
		).toBeGreaterThan(0);
		expect(
			(
				snap.query("SELECT head_rev FROM map_info").get() as {
					head_rev: number;
				}
			).head_rev,
		).toBe(1);
		snap.close();

		// Every blob the snapshot references was copied.
		const live = new Database(join(t.env.DATA_DIR, "db.sqlite"), {
			readonly: true,
		});
		const hashes = (
			live
				.query(
					"SELECT DISTINCT blob_hash AS h FROM tile_versions WHERE blob_hash IS NOT NULL",
				)
				.all() as { h: string }[]
		).map((r) => r.h);
		live.close();
		for (const h of hashes)
			expect(
				existsSync(
					join(dest, "blobs", h.slice(0, 2), h.slice(2, 4), `${h}.webp`),
				),
			).toBe(true);

		await upload(t, await solid(16, 16, [1, 2, 3]), 16, 0);
		const second = await backup({
			dataDir: t.env.DATA_DIR,
			dest,
			now: new Date(Date.UTC(2026, 10, 10, 13, 0, 0)),
		});
		expect(second.blobsSkipped).toBe(first.blobsCopied);
		expect(second.blobsCopied).toBeGreaterThan(0);
		expect(readdirSync(dest).filter((n) => n.startsWith("db-"))).toHaveLength(
			2,
		);
	});

	test("snapshot names sort by time, in UTC", async () => {
		const t = await withData();
		const dest = tmp("backup");
		const a = await backup({
			dataDir: t.env.DATA_DIR,
			dest,
			now: new Date(Date.UTC(2026, 5, 1, 9, 0, 0, 5)),
		});
		const b = await backup({
			dataDir: t.env.DATA_DIR,
			dest,
			now: new Date(Date.UTC(2026, 5, 1, 9, 0, 0, 6)),
		});
		expect(a.snapshot).toEndWith("db-20260601T090000005Z.sqlite");
		expect(b.snapshot).toEndWith("db-20260601T090000006Z.sqlite");
	});

	test("a blob left half-copied by an interrupted run is not mistaken for a backup", async () => {
		const t = await withData();
		const dest = tmp("backup");
		await backup({ dataDir: t.env.DATA_DIR, dest });
		const leftovers = readdirSync(dest, { recursive: true }).filter((n) =>
			String(n).endsWith(".tmp"),
		);
		expect(leftovers).toEqual([]);
	});

	test("keeps only the newest N snapshots", async () => {
		const t = await withData();
		const dest = tmp("backup");
		for (let h = 1; h <= 4; h++) {
			await backup({
				dataDir: t.env.DATA_DIR,
				dest,
				keep: 2,
				now: new Date(Date.UTC(2026, 0, 1, h, 0, 0)),
			});
		}
		expect(
			readdirSync(dest)
				.filter((n) => n.startsWith("db-"))
				.sort(),
		).toEqual([
			"db-20260101T030000000Z.sqlite",
			"db-20260101T040000000Z.sqlite",
		]);
	});

	test("complains clearly when there is nothing to back up", async () => {
		await expect(
			backup({ dataDir: tmp("empty"), dest: tmp("dest") }),
		).rejects.toThrow("no database");
	});
});

describe("gc-blobs", () => {
	const old = Date.now() - 24 * 3600_000;
	const hash = (c: string) => c.repeat(64);
	const blobPath = (dir: string, h: string) =>
		join(dir, "blobs", h.slice(0, 2), h.slice(2, 4), `${h}.webp`);
	function plant(dir: string, h: string, age = old) {
		const file = blobPath(dir, h);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, "data");
		utimesSync(file, new Date(age), new Date(age));
		return file;
	}

	test("reports unreferenced blobs, and deletes only old ones when asked", async () => {
		const t = await withData();
		const dir = t.env.DATA_DIR;
		const orphan = plant(dir, hash("a"));
		const young = plant(dir, hash("b"), Date.now());

		const report = await gcBlobs({ dataDir: dir, deleteFiles: false });
		expect(report.unreferenced).toEqual([orphan]);
		expect(report.skippedYoung).toBe(1);
		expect(report.referenced).toBeGreaterThan(0);
		expect(existsSync(orphan)).toBe(true);

		const done = await gcBlobs({ dataDir: dir, deleteFiles: true });
		expect(done.deleted).toBe(1);
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(young)).toBe(true);

		// Everything still referenced survives, so the map still renders.
		const check = await gcBlobs({ dataDir: dir, deleteFiles: false });
		expect(check.referenced).toBe(report.referenced);
	});

	test("forgets the sizes of deleted blobs and records the new storage", async () => {
		const t = await withData();
		plant(t.env.DATA_DIR, hash("e"));
		await t.db.insert(blobFiles).values({ hash: hash("e"), bytes: 4 });
		const before = (await t.db.select().from(blobFiles)).length;
		await gcBlobs({ dataDir: t.env.DATA_DIR, deleteFiles: true });
		expect(await t.db.select().from(blobFiles)).toHaveLength(before - 1);
		expect((await t.db.select().from(storageHistory)).at(-1)?.reason).toBe(
			"gc",
		);
	});

	test("never touches referenced blobs even when they are old", async () => {
		const t = await withData();
		const dir = t.env.DATA_DIR;
		const live = new Database(join(dir, "db.sqlite"), { readonly: true });
		const h = (
			live
				.query(
					"SELECT blob_hash AS h FROM tile_versions WHERE blob_hash IS NOT NULL LIMIT 1",
				)
				.get() as { h: string }
		).h;
		live.close();
		const file = blobPath(dir, h);
		utimesSync(file, new Date(old), new Date(old));
		await gcBlobs({ dataDir: dir, deleteFiles: true });
		expect(existsSync(file)).toBe(true);
	});

	test("refuses to delete while jobs are pending", async () => {
		const t = await withData();
		plant(t.env.DATA_DIR, hash("c"));
		await t.db
			.insert(jobs)
			.values({ type: "process_upload", payload: {}, status: "pending" });
		await expect(
			gcBlobs({ dataDir: t.env.DATA_DIR, deleteFiles: true }),
		).rejects.toThrow("pending or processing");
		expect(
			(await gcBlobs({ dataDir: t.env.DATA_DIR, deleteFiles: false }))
				.unreferenced,
		).toHaveLength(1);
	});

	test("old leftover temp files are collected too", async () => {
		const t = await withData();
		const tmpFile = `${blobPath(t.env.DATA_DIR, hash("d"))}.abc123.tmp`;
		mkdirSync(join(tmpFile, ".."), { recursive: true });
		writeFileSync(tmpFile, "partial");
		utimesSync(tmpFile, new Date(old), new Date(old));
		const r = await gcBlobs({ dataDir: t.env.DATA_DIR, deleteFiles: true });
		expect(r.deleted).toBe(1);
		expect(existsSync(tmpFile)).toBe(false);
	});
});

async function withData() {
	const t = await bootTiles();
	await upload(t, await solid(16, 16, RED), 0, 0);
	return t;
}

describe("import-v1", () => {
	/** A v1 output tree: <dimension>/<zoom>/<x>_<z>.png with black meaning "no data". */
	async function makeV1() {
		const src = tmp("v1");
		const write = async (
			dim: string,
			zoom: number,
			name: string,
			data: Buffer,
		) => {
			mkdirSync(join(src, dim, String(zoom)), { recursive: true });
			writeFileSync(join(src, dim, String(zoom), name), data);
		};
		const half = await png(512, 512, (x) =>
			x < 256 ? [0, 0, 0] : [10, 200, 30],
		);
		await write("overworld", 0, "-512_0.png", half);
		await write(
			"overworld",
			0,
			"0_0.png",
			await solid(512, 512, [200, 30, 30]),
		);
		await write(
			"overworld",
			0,
			"0_512.png",
			await solid(512, 512, [30, 30, 200]),
		);
		await write("overworld", 0, "1024_0.png", await solid(512, 512, [0, 0, 0])); // nothing to import
		await write("overworld", 1, "0_0.png", await solid(512, 512, [9, 9, 9])); // zoom 1 is rebuilt, not imported
		await write("overworld", 0, "notes.txt", Buffer.from("ignore me"));
		await write("overworld", 0, "weird.png", await solid(8, 8, [1, 1, 1]));
		await write(
			"nether",
			0,
			"512_-512.png",
			await solid(512, 512, [150, 40, 40]),
		);
		return src;
	}

	const inProcess = (
		app: {
			request: (p: string, i?: RequestInit) => Response | Promise<Response>;
		},
		seen?: string[],
	) =>
		(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url,
			);
			seen?.push(`${init?.method ?? "GET"} ${url.pathname}`);
			return app.request(url.pathname + url.search, init);
		}) as typeof fetch;

	async function server() {
		const t = makeTestApp({ DEFAULT_TILE_SIZE: "512", MAX_ZOOM: "2" });
		const user = await makeUser(t.db, "importer");
		return { ...t, token: user.token };
	}

	const tile = async (
		app: { request: (p: string) => Response | Promise<Response> },
		dim: string,
		zoom: number,
		x: number,
		y: number,
	) => {
		const res = await app.request(
			`/api/dimensions/${dim}/tiles/${zoom}/${x}/${y}`,
		);
		if (res.status === 204) return null;
		const blob = await app.request(res.headers.get("location") as string);
		return decodeRgba(new Uint8Array(await blob.arrayBuffer()));
	};

	test("uploads every tile with its coordinates; black stays transparent; zoom levels are rebuilt", async () => {
		const src = await makeV1();
		const t = await server();
		const logs: string[] = [];
		const result = await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			batch: 2,
			pollMs: 5,
			fetch: inProcess(t.app),
			log: (m) => logs.push(m),
		});
		// Five tiles in batches of two; the black one rides along with a real tile.
		expect(result).toEqual({ uploaded: 5, skipped: 0, batches: 3 });

		// Negative coordinate tile: left half black -> transparent, right half green.
		const west = await tile(t.app, "overworld", 0, -1, 0);
		expect(west).not.toBeNull();
		const px = (x: number, y: number) => [
			...(west as NonNullable<typeof west>).data.subarray(
				(y * 512 + x) * 4,
				(y * 512 + x) * 4 + 4,
			),
		];
		expect(px(10, 10)[3]).toBe(0);
		expect(px(400, 10)).toEqual([10, 200, 30, 255]);

		expect(await tile(t.app, "overworld", 0, 0, 1)).not.toBeNull();
		expect(await tile(t.app, "overworld", 0, 2, 0)).toBeNull(); // the all-black tile
		expect(await tile(t.app, "nether", 0, 1, -1)).not.toBeNull();
		expect(await tile(t.app, "overworld", 2, 0, 0)).not.toBeNull(); // pyramid built by the server
		expect(logs.some((l) => l.startsWith("overworld: 4 tiles"))).toBe(true);
	});

	test("a batch of only black tiles is skipped, not treated as a failure", async () => {
		const src = await makeV1();
		const t = await server();
		const logs: string[] = [];
		const result = await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			dims: ["overworld"],
			batch: 1,
			pollMs: 5,
			fetch: inProcess(t.app),
			log: (m) => logs.push(m),
		});
		expect(result).toEqual({ uploaded: 3, skipped: 1, batches: 4 });
		expect(logs.some((l) => l.includes("empty (1 tiles)"))).toBe(true);
	});

	test("an interrupted run resumes without uploading finished tiles again", async () => {
		const src = await makeV1();
		const t = await server();
		const state = join(tmp("state"), "state.json");
		const seen: string[] = [];
		const base = inProcess(t.app, seen);

		let uploads = 0;
		const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST" && ++uploads === 3)
				throw new Error("connection lost");
			return base(input, init);
		}) as typeof fetch;
		const quiet = () => {};
		await expect(
			runImport({
				url: "http://map.test",
				token: t.token,
				src,
				batch: 1,
				statePath: state,
				pollMs: 5,
				fetch: flaky,
				log: quiet,
			}),
		).rejects.toThrow("connection lost");
		const afterCrash = JSON.parse(await Bun.file(state).text()) as {
			done: Record<string, string[]>;
		};
		expect(afterCrash.done.nether).toEqual(["512_-512.png"]);
		expect(Object.values(afterCrash.done).flat()).toHaveLength(2);

		seen.length = 0;
		const result = await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			batch: 1,
			statePath: state,
			pollMs: 5,
			fetch: base,
			log: quiet,
		});
		expect(result.uploaded + result.skipped).toBe(3); // 5 tiles in total, 2 were already done
		expect(
			seen.filter((s) => s.startsWith("POST") && s.includes("/uploads")),
		).toHaveLength(3);

		// A third run has nothing left to do.
		seen.length = 0;
		const again = await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			batch: 1,
			statePath: state,
			pollMs: 5,
			fetch: base,
			log: quiet,
		});
		expect(again).toEqual({ uploaded: 0, skipped: 0, batches: 0 });
		expect(seen.some((s) => s.includes("/uploads"))).toBe(false);
	});

	test("--dims and --dim-map select and rename dimensions", async () => {
		const src = await makeV1();
		const t = await server();
		const quiet = () => {};
		const r = await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			dims: ["nether"],
			dimMap: { nether: "the_end" },
			pollMs: 5,
			fetch: inProcess(t.app),
			log: quiet,
		});
		expect(r.uploaded).toBe(1);
		expect(await tile(t.app, "the_end", 0, 1, -1)).not.toBeNull();
		expect(await tile(t.app, "overworld", 0, 0, 0)).toBeNull();
	});

	test("clear errors for bad tokens, unknown dimensions and empty sources", async () => {
		const src = await makeV1();
		const t = await server();
		const run = (over: Partial<Parameters<typeof runImport>[0]>) =>
			runImport({
				url: "http://map.test",
				token: t.token,
				src,
				pollMs: 5,
				fetch: inProcess(t.app),
				log: () => {},
				...over,
			});

		await expect(run({ token: "aomc_wrong" })).rejects.toThrow("HTTP 401");
		await expect(run({ dimMap: { overworld: "atlantis" } })).rejects.toThrow(
			'dimension "atlantis" does not exist',
		);
		await expect(run({ src: tmp("empty-src") })).rejects.toThrow(
			"no <dimension>/0 folders",
		);
	});

	test("rate limiting by the server is retried instead of failing", async () => {
		const src = await makeV1();
		const t = await server();
		const base = inProcess(t.app);
		let limited = false;
		const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST" && !limited) {
				limited = true;
				return new Response(JSON.stringify({ error: "too many uploads" }), {
					status: 429,
				});
			}
			return base(input, init);
		}) as typeof fetch;
		const r = await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			dims: ["nether"],
			pollMs: 5,
			retryMs: 1,
			fetch: f,
			log: () => {},
		});
		expect(r.uploaded).toBe(1);
		expect(limited).toBe(true);
	});
});

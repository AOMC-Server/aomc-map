import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	blobFiles,
	jobs,
	storageHistory,
	uploadPatches,
} from "../server/src/db/schema";
import { classifyBlobFile } from "../server/src/tiles/blobstore";
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
import { positiveNumber } from "./args";
import { backup } from "./backup";
import { gcBlobs } from "./gc-blobs";
import { runImport, xaeroStamp } from "./import-v1";

afterAll(cleanupTempDirs);

const tmp = (name: string) => makeTempDir(`aomc-${name}-`);

async function withData() {
	const t = await bootTiles();
	await upload(t, await solid(16, 16, RED), 0, 0);
	return t;
}

/** Runs a script as the command line would. */
async function runScript(script: string, ...args: string[]) {
	const proc = Bun.spawn(["bun", join(import.meta.dir, script), ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stderr };
}

describe("positiveNumber", () => {
	test("accepts positive numbers, in strings too", () => {
		expect(positiveNumber("x", "60")).toBe(60);
		expect(positiveNumber("x", 0.5)).toBe(0.5);
		expect(positiveNumber("x", " 7 ", { integer: true })).toBe(7);
	});

	test("rejects everything else instead of letting NaN through", () => {
		for (const bad of ["1h", "", " ", "abc", "0", "-5", "Infinity", "NaN"])
			expect(() => positiveNumber("min-age-minutes", bad)).toThrow(
				"--min-age-minutes must be a positive number",
			);
		expect(() => positiveNumber("batch", "1.5", { integer: true })).toThrow(
			"whole number",
		);
	});
});

describe("blob file names", () => {
	const h = "a".repeat(64);
	test("tell stored tiles, copies and temp files apart", () => {
		expect(classifyBlobFile(`${h}.webp`)).toEqual({ kind: "blob", hash: h });
		expect(classifyBlobFile(`${h}.80.jpg`)).toEqual({ kind: "copy", hash: h });
		expect(classifyBlobFile(`${h}.lossy.webp`)).toEqual({
			kind: "copy",
			hash: h,
		});
		expect(classifyBlobFile(`${h}.webp.abc123.tmp`)).toEqual({
			kind: "temp",
			hash: null,
		});
		expect(classifyBlobFile("notes.txt")).toBeNull();
		expect(classifyBlobFile("short.webp")).toBeNull();
	});
});

describe("backup", () => {
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

	test("--keep must be a positive whole number", async () => {
		for (const keep of ["0", "x", "1.5"]) {
			const r = await runScript("backup.ts", tmp("dest"), "--keep", keep);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain("--keep must be a positive whole number");
		}
		const t = await withData();
		await expect(
			backup({ dataDir: t.env.DATA_DIR, dest: tmp("dest"), keep: Number.NaN }),
		).rejects.toThrow("--keep must be");
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

	test("--min-age-minutes must be a positive number: 1h would disable the age check", async () => {
		const t = await withData();
		const young = plant(t.env.DATA_DIR, hash("a"), Date.now());
		for (const bad of ["1h", "", "0", "-1"]) {
			const r = await runScript(
				"gc-blobs.ts",
				"--data",
				t.env.DATA_DIR,
				"--delete",
				`--min-age-minutes=${bad}`,
			);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain("--min-age-minutes must be a positive number");
		}
		expect(existsSync(young)).toBe(true);
		await expect(
			gcBlobs({
				dataDir: t.env.DATA_DIR,
				deleteFiles: true,
				minAgeMs: Number.NaN,
			}),
		).rejects.toThrow("minAgeMs");
		expect(existsSync(young)).toBe(true);
	});

	test("a blob a job reuses while the scan runs is not deleted", async () => {
		const t = await withData();
		const dir = t.env.DATA_DIR;
		const reused = plant(dir, hash("a"));
		const orphan = plant(dir, hash("b"));
		const r = await gcBlobs({
			dataDir: dir,
			deleteFiles: true,
			// The blob store's put() of an existing blob only refreshes its age.
			onStage: (stage) => {
				if (stage === "scanned") utimesSync(reused, new Date(), new Date());
			},
		});
		expect(existsSync(reused)).toBe(true);
		expect(existsSync(orphan)).toBe(false);
		expect(r.deleted).toBe(1);
		expect(r.unreferenced).toEqual([orphan]);
		expect(r.skippedYoung).toBe(1);
	});

	test("a blob that gets referenced after the scan is put back", async () => {
		const t = await withData();
		const dir = t.env.DATA_DIR;
		const claimed = plant(dir, hash("a"));
		const orphan = plant(dir, hash("b"));
		const copy = claimed.replace(/\.webp$/, ".png");
		writeFileSync(copy, "copy");
		utimesSync(copy, new Date(old), new Date(old));
		const r = await gcBlobs({
			dataDir: dir,
			deleteFiles: true,
			onStage: async (stage) => {
				if (stage !== "quarantined") return;
				expect(existsSync(claimed)).toBe(false); // waiting in quarantine
				await t.db
					.insert(uploadPatches)
					.values({ revisionId: 1, tileX: 99, tileY: 99, blobHash: hash("a") });
			},
		});
		expect(existsSync(claimed)).toBe(true);
		expect(existsSync(copy)).toBe(true);
		expect(existsSync(orphan)).toBe(false);
		expect(r.deleted).toBe(1);
		expect(existsSync(join(dir, "gc-quarantine"))).toBe(false);
	});

	test("a job that appears after the scan stops the deletion and nothing is lost", async () => {
		const t = await withData();
		const dir = t.env.DATA_DIR;
		const orphan = plant(dir, hash("a"));
		await expect(
			gcBlobs({
				dataDir: dir,
				deleteFiles: true,
				onStage: async (stage) => {
					if (stage === "quarantined")
						await t.db.insert(jobs).values({
							type: "process_upload",
							payload: {},
							status: "processing",
						});
				},
			}),
		).rejects.toThrow("started while");
		expect(existsSync(orphan)).toBe(true);
		expect(existsSync(join(dir, "gc-quarantine"))).toBe(false);
	});

	test("a blob rewritten by a job while its old file is in quarantine is kept", async () => {
		const t = await withData();
		const dir = t.env.DATA_DIR;
		const orphan = plant(dir, hash("a"));
		const r = await gcBlobs({
			dataDir: dir,
			deleteFiles: true,
			onStage: (stage) => {
				if (stage === "quarantined") writeFileSync(orphan, "data");
			},
		});
		expect(existsSync(orphan)).toBe(true);
		expect(r.deleted).toBe(0);
	});

	test("files left in quarantine by a killed run are judged again, not lost", async () => {
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
		const rel = join(h.slice(0, 2), h.slice(2, 4), `${h}.webp`);
		const held = join(dir, "gc-quarantine", rel);
		mkdirSync(join(held, ".."), { recursive: true });
		writeFileSync(held, "x");
		await gcBlobs({ dataDir: dir, deleteFiles: true });
		expect(existsSync(blobPath(dir, h))).toBe(true);
		expect(existsSync(join(dir, "gc-quarantine"))).toBe(false);
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

	test("copies in other formats go with their WebP and stay while it is referenced", async () => {
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
		const kept: string[] = [];
		for (const suffix of [".png", ".80.jpg", ".lossy.webp"]) {
			expect((await t.app.request(`/blobs/${h}${suffix}`)).status).toBe(200);
			const file = blobPath(dir, h).replace(/\.webp$/, suffix);
			expect(existsSync(file)).toBe(true);
			utimesSync(file, new Date(old), new Date(old));
			kept.push(file);
		}

		const webp = plant(dir, hash("f"));
		const orphans = [".png", ".95.jpg", ".lossy.webp"].map((suffix) => {
			const file = webp.replace(/\.webp$/, suffix);
			writeFileSync(file, "copy");
			utimesSync(file, new Date(old), new Date(old));
			return file;
		});

		const r = await gcBlobs({ dataDir: dir, deleteFiles: true });
		expect(r.deleted).toBe(4);
		expect(r.total).toBe(r.referenced + 1);
		for (const f of orphans) expect(existsSync(f)).toBe(false);
		for (const f of kept) expect(existsSync(f)).toBe(true);
	});
});

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
			'dimension "atlantis" not on the map',
		);
		await expect(run({ src: tmp("empty-src") })).rejects.toThrow(
			"no <dimension>/0 folders",
		);
	});

	const revisionDates = async (t: {
		app: ReturnType<typeof makeTestApp>["app"];
	}) => {
		const dates: (number | null)[] = [];
		for (let id = 1; ; id++) {
			const res = await t.app.request(`/api/revisions/${id}`);
			if (res.status !== 200) return dates;
			const { revision } = (await res.json()) as {
				revision: { exportedAt: number | null };
			};
			dates.push(revision.exportedAt);
		}
	};

	test("xaeroStamp writes the UTC time the way Xaero names exports", () => {
		expect(xaeroStamp(Date.UTC(2026, 1, 10, 15, 6, 41))).toBe(
			"2026-02-10_15.06.41",
		);
		// The server ignores dates before 2000, which would make the tile count as new.
		expect(xaeroStamp(0)).toBe("2000-01-01_00.00.00");
	});

	test("tiles get the export date of their file's modified time, so they sit under newer exports", async () => {
		const src = await makeV1();
		const touch = (name: string, at: number) =>
			utimesSync(join(src, "overworld", "0", name), new Date(at), new Date(at));
		const day10 = Date.UTC(2026, 0, 10);
		const day12 = Date.UTC(2026, 0, 12);
		touch("0_0.png", day10 + 5 * 3600_000);
		touch("0_512.png", day12 + 7 * 3600_000);
		touch("-512_0.png", day12 + 1000);
		touch("1024_0.png", day10);
		const t = await server();
		const r = await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			dims: ["overworld"],
			pollMs: 5,
			fetch: inProcess(t.app),
			log: () => {},
		});
		expect(r.uploaded).toBe(4);
		// One batch, one revision per export date, oldest first.
		expect(await revisionDates(t)).toEqual([day10, day12]);
	});

	test("--date gives every tile the same export date", async () => {
		const src = await makeV1();
		const t = await server();
		const date = Date.UTC(2025, 5, 1, 12, 30, 0);
		await runImport({
			url: "http://map.test",
			token: t.token,
			src,
			date,
			pollMs: 5,
			fetch: inProcess(t.app),
			log: () => {},
		});
		expect(await revisionDates(t)).toEqual([date, date]); // one revision per dimension
	});

	test("batches respect the server's upload size and file count limits", async () => {
		const src = await makeV1();
		const dir = join(src, "overworld", "0");
		const biggest = Math.max(
			...["-512_0", "0_0", "0_512", "1024_0"].map(
				(n) => statSync(join(dir, `${n}.png`)).size,
			),
		);
		const run = async (env: Record<string, string>) => {
			const t = makeTestApp({
				DEFAULT_TILE_SIZE: "512",
				MAX_ZOOM: "2",
				...env,
			});
			const user = await makeUser(t.db, "importer");
			return runImport({
				url: "http://map.test",
				token: user.token,
				src,
				dims: ["overworld"],
				batch: 200,
				pollMs: 5,
				fetch: inProcess(t.app),
				log: () => {},
			});
		};
		// Room for two files per request (the importer keeps some headroom below the limit).
		const sized = await run({
			MAX_UPLOAD_BYTES: String(Math.ceil((2.5 * biggest) / 0.9)),
		});
		expect(sized.uploaded + sized.skipped).toBe(4);
		expect(sized.batches).toBe(2);
		const counted = await run({ MAX_FILES_PER_UPLOAD: "1" });
		expect(counted.uploaded + counted.skipped).toBe(4);
		expect(counted.batches).toBe(4);
	});

	test("--batch must be a positive whole number", async () => {
		const src = await makeV1();
		const t = await server();
		await expect(
			runImport({
				url: "http://map.test",
				token: t.token,
				src,
				batch: Number.NaN,
				fetch: inProcess(t.app),
				log: () => {},
			}),
		).rejects.toThrow("--batch must be a positive whole number");
		const r = await runScript(
			"import-v1.ts",
			"--url",
			"http://map.test",
			"--token",
			"x",
			"--src",
			src,
			"--batch",
			"lots",
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("--batch must be a positive whole number");
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

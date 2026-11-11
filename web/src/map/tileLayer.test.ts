import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PreloadRing } from "@aomc/shared/schemas";
import type { View } from "@aomc/shared/view";
import { preloadHudLines } from "./debugLayer";
import {
	MAX_PRELOAD_TILES,
	type PreloadDebugInfo,
	type PreloadProgress,
	preloadTiles,
	TileLayer,
} from "./tileLayer";

const T = 16;
const size = { width: 31, height: 15 }; // covers exactly level-0 tiles 0 and 1 (z = 0)
const view: View = { centerX: 16, centerZ: 8, zoom: 0 };

type FakeBitmap = { label: string; closed: boolean; close(): void };
type Pending = {
	url: string;
	signal: AbortSignal;
	respond: (label: string | null) => Promise<void>;
};

const realFetch = globalThis.fetch;
const realBitmap = globalThis.createImageBitmap;
let pending: Pending[];
let bitmaps: FakeBitmap[];

beforeEach(() => {
	pending = [];
	bitmaps = [];
	// Every request waits until the test responds to it; null means 204 (empty tile).
	globalThis.fetch = ((url: string, init: { signal: AbortSignal }) =>
		new Promise((resolve, reject) => {
			init.signal.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError")),
			);
			pending.push({
				url,
				signal: init.signal,
				respond: async (label) => {
					resolve(
						label === null
							? { status: 204, ok: true }
							: { status: 200, ok: true, blob: async () => label },
					);
					await Bun.sleep(0);
					await Bun.sleep(0);
				},
			});
		})) as unknown as typeof fetch;
	globalThis.createImageBitmap = (async (label: string) => {
		const b: FakeBitmap = {
			label,
			closed: false,
			close() {
				this.closed = true;
			},
		};
		bitmaps.push(b);
		return b;
	}) as unknown as typeof createImageBitmap;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	globalThis.createImageBitmap = realBitmap;
});

function makeLayer(preload?: PreloadRing[]) {
	let changes = 0;
	const progress: PreloadProgress[] = [];
	const layer = new TileLayer({
		tileSize: T,
		maxZoom: 3,
		onChange: () => changes++,
		preload,
		onPreloadProgress: (p) => progress.push(p),
	});
	const draws: string[] = [];
	const ctx = {
		imageSmoothingEnabled: true,
		imageSmoothingQuality: "low",
		drawImage: (b: FakeBitmap) => draws.push(b.label),
	} as unknown as CanvasRenderingContext2D;
	const frame = (v: View = view) => {
		draws.length = 0;
		layer.draw(ctx, v, size, 1);
		return [...draws];
	};
	return { layer, frame, changes: () => changes, progress };
}

const rev = (r: number) => (z: number, x: number, y: number) =>
	`/tiles/${z}/${x}/${y}?rev=${r}`;

/** Loads everything currently requested with labels like "r1:0/0/0". */
async function answerAll(label: (url: string) => string | null) {
	const batch = pending.splice(0);
	for (const p of batch) await p.respond(label(p.url));
}

const labelOf = (url: string) => {
	const m = /tiles\/(\d+)\/(-?\d+)\/(-?\d+)\?rev=(\d+)/.exec(
		url,
	) as RegExpExecArray;
	return `r${m[4]}:${m[1]}/${m[2]}/${m[3]}`;
};
const level0 = (labels: string[]) =>
	labels.filter((l) => l.includes(":0/")).sort();

describe("TileLayer revision changes", () => {
	test("old images stay on screen until the new ones replace them in place", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		await answerAll(labelOf);
		expect(level0(frame())).toEqual(["r1:0/0/0", "r1:0/1/0"]);

		layer.setSource(rev(2), true);
		// Same frame right after the switch: nothing may disappear.
		expect(level0(frame())).toEqual(["r1:0/0/0", "r1:0/1/0"]);
		expect(pending.some((p) => p.url.includes("rev=2"))).toBe(true);

		await answerAll(labelOf);
		expect(level0(frame())).toEqual(["r2:0/0/0", "r2:0/1/0"]);
		// The replaced bitmaps are released.
		expect(
			bitmaps.filter((b) => b.label.startsWith("r1:0/") && b.closed),
		).toHaveLength(2);
	});

	test("rapid successive changes never blank the view", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		await answerAll(labelOf);

		// Scrub through several revisions before any new tile arrives.
		for (const r of [2, 3, 4]) {
			layer.setSource(rev(r), true);
			expect(level0(frame())).toEqual(["r1:0/0/0", "r1:0/1/0"]);
		}
		// Requests for the superseded revisions were cancelled; only the latest is outstanding.
		expect(
			pending
				.filter((p) => !p.signal.aborted)
				.every((p) => p.url.includes("rev=4")),
		).toBe(true);

		await answerAll(labelOf);
		expect(level0(frame())).toEqual(["r4:0/0/0", "r4:0/1/0"]);
	});

	test("a late response for a superseded revision is discarded", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		await answerAll(labelOf);

		layer.setSource(rev(2), true);
		frame();
		const slow = pending.splice(0);
		layer.setSource(rev(3), true);
		frame();
		for (const p of slow) await p.respond(labelOf(p.url)); // arrives after being superseded
		expect(level0(frame())).toEqual(["r1:0/0/0", "r1:0/1/0"]);
		await answerAll(labelOf);
		expect(level0(frame())).toEqual(["r3:0/0/0", "r3:0/1/0"]);
	});

	test("panning onto a tile loaded at an older revision shows it while the new one loads", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		const away: View = { centerX: 32, centerZ: 8, zoom: 0 }; // tiles 1 and 2
		frame(away);
		await answerAll(labelOf);
		expect(level0(frame(away))).toEqual(["r1:0/1/0", "r1:0/2/0"]);

		layer.setSource(rev(2), true);
		expect(level0(frame(away))).toEqual(["r1:0/1/0", "r1:0/2/0"]);
		await answerAll(labelOf);
		// Pan to tiles 0 and 1: tile 1 is fresh, tile 0 was never loaded (blank, not stale garbage).
		const shown = level0(frame(view));
		expect(shown).toContain("r2:0/1/0");
		expect(shown).not.toContain("r1:0/1/0");
	});

	test("a tile that became empty replaces the old image with nothing", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		await answerAll(labelOf);
		layer.setSource(rev(2), true);
		frame();
		await answerAll((url) => (url.includes("/0/0/0") ? null : labelOf(url)));
		expect(level0(frame())).toEqual(["r2:0/1/0"]);
	});

	test("without keepPrevious (another map or dimension) the old images are dropped", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		await answerAll(labelOf);
		const old = [...bitmaps];
		layer.setSource((z, x, y) => `/other/${z}/${x}/${y}?rev=1`, false);
		expect(frame()).toEqual([]);
		expect(old.every((b) => b.closed)).toBe(true);
	});

	test("a fresh coarse tile beats a stale empty one", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		// At rev 1 the level-0 tile (0,0) is empty; its parent at level 1 is empty too.
		await answerAll(() => null);
		layer.setSource(rev(2), true);
		frame();
		const batch = pending.splice(0);
		// Content appears at rev 2: the coarse parent answers first, the exact tile is still loading.
		for (const p of batch.filter((p) => p.url.includes("/tiles/1/")))
			await p.respond("r2:1/0/0");
		expect(frame().some((l) => l === "r2:1/0/0")).toBe(true);
	});

	test("failed requests are retried only after a pause", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		globalThis.createImageBitmap = (async () => {
			throw new Error("decode failed");
		}) as unknown as typeof createImageBitmap;
		const origWarn = console.warn;
		console.warn = () => {};
		await answerAll(labelOf);
		console.warn = origWarn;
		const before = pending.length;
		frame();
		expect(pending.length).toBe(before); // still within the retry window
	});
});

describe("TileLayer with a lookup", () => {
	type Lookup = {
		zoom: number;
		rect: { minX: number; minY: number; maxX: number; maxY: number };
		resolve: (found: Record<string, string>) => Promise<void>;
		reject: () => Promise<void>;
	};
	let lookups: Lookup[];
	const lookup = (zoom: number, rect: Lookup["rect"]) =>
		new Promise<Map<string, string>>((resolve, reject) => {
			const settle = async () => {
				await Bun.sleep(0);
				await Bun.sleep(0);
			};
			lookups.push({
				zoom,
				rect,
				resolve: (found) => {
					resolve(new Map(Object.entries(found)));
					return settle();
				},
				reject: () => {
					reject(new Error("lookup failed"));
					return settle();
				},
			});
		});
	const byZoom = (z: number) => lookups.find((l) => l.zoom === z) as Lookup;
	const urls = () => pending.map((p) => p.url).sort();

	beforeEach(() => {
		lookups = [];
	});

	test("looks up each zoom level once and loads only the tiles that have images", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1), false, lookup);
		frame();
		expect(pending).toHaveLength(0);
		expect(lookups.map((l) => [l.zoom, l.rect])).toEqual([
			[0, { minX: 0, minY: 0, maxX: 1, maxY: 0 }],
			[1, { minX: 0, minY: 0, maxX: 0, maxY: 0 }],
		]);

		await byZoom(0).resolve({ "0/0": "/blobs/a" }); // tile 1 is empty
		await byZoom(1).resolve({ "0/0": "/blobs/p" });
		frame();
		expect(urls()).toEqual(["/blobs/a", "/blobs/p"]);
		await answerAll((url) => url);
		expect(frame()).toEqual(["/blobs/a"]);
		frame();
		expect(lookups).toHaveLength(2); // no further requests
		expect(pending).toHaveLength(0);
	});

	test("a tile whose image did not change is not loaded again", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1), false, lookup);
		frame();
		await byZoom(0).resolve({ "0/0": "/blobs/a", "1/0": "/blobs/b" });
		await byZoom(1).resolve({});
		frame();
		await answerAll((url) => url);

		lookups = [];
		layer.setSource(rev(2), true, lookup);
		expect(frame().sort()).toEqual(["/blobs/a", "/blobs/b"]);
		await byZoom(0).resolve({ "0/0": "/blobs/a", "1/0": "/blobs/c" });
		await byZoom(1).resolve({});
		frame();
		expect(urls()).toEqual(["/blobs/c"]);
		await answerAll((url) => url);
		expect(frame().sort()).toEqual(["/blobs/a", "/blobs/c"]);
		expect(bitmaps.find((b) => b.label === "/blobs/a")?.closed).toBe(false);
	});

	test("an answer for a superseded source is ignored", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1), false, lookup);
		frame();
		const old = lookups.splice(0);
		layer.setSource(rev(2), true, lookup);
		frame();
		for (const l of old) await l.resolve({ "0/0": "/blobs/old" });
		frame();
		expect(urls()).toEqual([]);
	});

	test("if the lookup fails, tiles load one by one", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1), false, lookup);
		frame();
		const origWarn = console.warn;
		console.warn = () => {};
		for (const l of lookups) await l.reject();
		console.warn = origWarn;
		frame();
		expect(urls()).toEqual([
			"/tiles/0/0/0?rev=1",
			"/tiles/0/1/0?rev=1",
			"/tiles/1/0/0?rev=1",
		]);
	});
});

describe("TileLayer preload", () => {
	// Level 2 tiles span 64 blocks: radius 64 is the 2x2 tiles around the origin.
	const rings: PreloadRing[] = [{ level: 2, radius: 64 }];
	const far: View = { centerX: 10000, centerZ: 8, zoom: 0 };

	test("spawn tiles load after the visible ones, wherever the view is", () => {
		const { layer, frame } = makeLayer(rings);
		layer.setSource(rev(1));
		frame(far);
		expect(pending.map((p) => labelOf(p.url))).toEqual([
			"r1:0/624/0",
			"r1:0/625/0",
			"r1:1/312/0",
			"r1:2/-1/-1",
			"r1:2/0/-1",
			"r1:2/-1/0",
			"r1:2/0/0",
		]);
	});

	test("a preloaded tile stands in at spawn before the detailed tiles arrive", async () => {
		const { layer, frame } = makeLayer(rings);
		layer.setSource(rev(1));
		frame(far);
		await answerAll(labelOf);
		expect(frame()).toEqual(["r1:2/0/0", "r1:2/0/0"]);
	});

	test("spawn tiles are looked up separately from a distant view", () => {
		const rects: unknown[] = [];
		const { layer, frame } = makeLayer(rings);
		layer.setSource(rev(1), false, (zoom, rect) => {
			if (zoom === 2) rects.push(rect);
			return new Promise(() => {});
		});
		frame({ ...far, zoom: 2 }); // level 2 is also the visible level here
		expect(rects).toEqual([
			{ minX: 155, minY: -1, maxX: 157, maxY: 0 },
			{ minX: -1, minY: -1, maxX: 0, maxY: 0 },
		]);
	});

	test("reports progress as tiles arrive, and only when it changes", async () => {
		const { layer, frame, progress } = makeLayer(rings);
		layer.setSource(rev(1));
		frame(far);
		frame(far);
		expect(progress).toEqual([{ done: 0, failed: 0, total: 4 }]);
		const spawn = pending.filter((p) => p.url.startsWith("/tiles/2/"));
		await (spawn[0] as Pending).respond("a");
		await (spawn[1] as Pending).respond(null); // empty counts as loaded
		frame(far);
		expect(progress.at(-1)).toEqual({ done: 2, failed: 0, total: 4 });
	});

	test("a new revision keeps the preload complete; another dimension starts over", async () => {
		const { layer, frame, progress } = makeLayer(rings);
		layer.setSource(rev(1));
		frame(far);
		await answerAll(labelOf);
		frame(far);
		expect(progress.at(-1)).toEqual({ done: 4, failed: 0, total: 4 });

		layer.setSource(rev(2), true);
		frame(far);
		expect(progress.at(-1)).toEqual({ done: 4, failed: 0, total: 4 });

		layer.setSource(rev(3), false);
		frame(far);
		expect(progress.at(-1)).toEqual({ done: 0, failed: 0, total: 4 });
	});

	test("the debug view shows each preloaded tile's state, per level", async () => {
		const { layer, frame } = makeLayer([
			...rings,
			{ level: 3, radius: 100 }, // 2×2 tiles of 128 blocks
		]);
		layer.collectDebug = true;
		layer.setSource(rev(1));
		frame();
		// Level 3 comes first; one of its tiles has an image, the others are empty.
		await answerAll((url) =>
			url.startsWith("/tiles/3/0/0")
				? "a"
				: url.startsWith("/tiles/3/")
					? null
					: "x",
		);
		frame(); // starts the level 2 tiles
		await (
			pending.find((p) => p.url.startsWith("/tiles/2/0/0")) as Pending
		).respond(null);
		frame();
		const info = layer.debugInfo?.preload;
		expect(info?.levels.map((l) => [l.level, l.radius, l.total])).toEqual([
			[3, 100, 4],
			[2, 64, 4],
		]);
		expect(info?.levels[0]?.counts).toMatchObject({ ready: 1, empty: 3 });
		// The first level 2 tile was in the first batch, with an image.
		expect(info?.levels[1]?.counts).toMatchObject({
			ready: 1,
			empty: 1,
			loading: 2,
		});
		const states = Object.fromEntries(
			info?.tiles.map((t) => [`${t.level}/${t.x}/${t.y}`, t.state]) ?? [],
		);
		// The view covers blocks 0..31 near spawn: only tiles touching it are listed.
		expect(states).toEqual({ "3/0/0": "ready", "2/0/0": "empty" });

		expect(preloadHudLines(info as PreloadDebugInfo)).toEqual([
			"preload L3 1/8   ≤100    4/4 done, 3 empty",
			"        L2 1/4   ≤64     2/4 done, 1 empty, 2 loading",
		]);
		layer.setPreload([]);
		frame();
		expect(
			preloadHudLines(layer.debugInfo?.preload as PreloadDebugInfo),
		).toEqual(["preload off"]);
	});

	test("rings can be changed or turned off", () => {
		const { layer, frame } = makeLayer(rings);
		layer.setSource(rev(1));
		layer.setPreload([]);
		frame(far);
		expect(pending.some((p) => p.url.startsWith("/tiles/2/"))).toBe(false);
		layer.setPreload([{ level: 3, radius: 1 }]);
		frame(far);
		expect(pending.map((p) => p.url)).toContain("/tiles/3/0/0?rev=1");
	});
});

describe("preloadTiles", () => {
	test("coarsest ring first, nearest spawn first, levels beyond maxZoom skipped", () => {
		const tiles = preloadTiles(
			[
				{ level: 1, radius: 64 }, // 4×4 tiles of 32 blocks
				{ level: 2, radius: 64 }, // 2×2 tiles of 64 blocks
				{ level: 9, radius: 1000 },
			],
			16,
			3,
		);
		expect(tiles.map((t) => t.zoom)).toEqual([
			...Array(4).fill(2),
			...Array(16).fill(1),
		]);
		// The 4 level 1 tiles touching spawn come before the outer ones.
		const inner = tiles
			.slice(4, 8)
			.map((t) => `${t.x},${t.y}`)
			.sort();
		expect(inner).toEqual(["-1,-1", "-1,0", "0,-1", "0,0"]);
	});

	test("is capped", () => {
		expect(preloadTiles([{ level: 0, radius: 1e6 }], 16, 3)).toHaveLength(
			MAX_PRELOAD_TILES,
		);
	});
});

describe("TileLayer pause", () => {
	test("requests nothing while paused but keeps drawing what was on screen", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		await answerAll(labelOf);
		expect(level0(frame())).toEqual(["r1:0/0/0", "r1:0/1/0"]);

		layer.setPaused(true);
		// Pan one tile to the right: tile 2 is new, tile 1 is still shown.
		const panned = frame({ ...view, centerX: 32 });
		expect(pending).toHaveLength(0);
		expect(level0(panned)).toEqual(["r1:0/1/0"]);

		layer.setPaused(false);
		frame({ ...view, centerX: 32 });
		expect(pending.some((p) => p.url.includes("/0/2/0"))).toBe(true);
	});

	test("tiles cached earlier but not on screen stay hidden while paused", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		await answerAll(labelOf);
		// Move away so tile 0 is cached but no longer drawn.
		const away = { ...view, centerX: 32 };
		frame(away);
		await answerAll(labelOf);
		frame(away);

		layer.setPaused(true);
		expect(level0(frame())).toEqual(["r1:0/1/0"]);
		layer.setPaused(false);
		expect(level0(frame())).toEqual(["r1:0/0/0", "r1:0/1/0"]);
	});

	test("loads that finish while paused appear only on resume", async () => {
		const { layer, frame } = makeLayer();
		layer.setSource(rev(1));
		frame();
		layer.setPaused(true);
		await answerAll(labelOf);
		expect(level0(frame())).toEqual([]);
		layer.setPaused(false);
		expect(level0(frame())).toEqual(["r1:0/0/0", "r1:0/1/0"]);
	});
});

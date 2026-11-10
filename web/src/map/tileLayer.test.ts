import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { View } from "./camera";
import { TileLayer } from "./tileLayer";

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

function makeLayer() {
	let changes = 0;
	const layer = new TileLayer({
		tileSize: T,
		maxZoom: 3,
		onChange: () => changes++,
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
	return { layer, frame, changes: () => changes };
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

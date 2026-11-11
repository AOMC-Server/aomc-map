import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, FIVE_MINUTES, HOUR, MINUTE } from "@aomc/shared";
import { eq } from "drizzle-orm";
import { blobFiles, storageHistory, trafficHourly } from "../src/db/schema";
import { recordMissingBlobSizes } from "../src/storage";
import {
	categoryOf,
	createTraffic,
	domainOf,
	NO_REFERRER,
	OTHER_DOMAIN,
	SELF_DOMAIN,
} from "../src/traffic";
import {
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	makeUser,
	RED,
	solid,
	T,
	upload,
} from "./helpers";

afterAll(cleanupTempDirs);

const boot = () => bootTiles({}, { owner: true });

describe("storage", () => {
	test("blob sizes are recorded when written, and history grows after uploads and deletions", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		await upload(t, await solid(T * 2, T, RED), 0, 0);

		const blobs = await t.db.select().from(blobFiles);
		expect(blobs.length).toBeGreaterThan(0);
		const history = await t.db.select().from(storageHistory);
		expect(history.map((h) => h.reason)).toEqual(["upload", "upload"]);
		const last = history[1];
		expect(last?.blobCount).toBe(blobs.length);
		expect(last?.blobBytes).toBe(blobs.reduce((n, b) => n + b.bytes, 0));
		expect(last?.referencedBytes).toBe(last?.blobBytes ?? -1);
		expect(last?.dbBytes).toBeGreaterThan(0);

		await erase(t, id);
		const after = await t.db.select().from(storageHistory);
		expect(after.at(-1)?.reason).toBe("erase");
		expect(after.at(-1)?.blobCount).toBe(blobs.length);
	});

	test("images written before sizes were tracked get a size once", async () => {
		const t = await boot();
		await upload(t, await solid(T, T, RED), 0, 0);
		const [known] = await t.db.select().from(blobFiles);
		await t.db.delete(blobFiles);
		const dir = join(t.env.DATA_DIR, "blobs");
		expect(await recordMissingBlobSizes(t.db, dir)).toBeGreaterThan(0);
		const [again] = await t.db
			.select()
			.from(blobFiles)
			.where(eq(blobFiles.hash, known?.hash ?? ""));
		expect(again?.bytes).toBe(known?.bytes ?? -1);
		expect(await recordMissingBlobSizes(t.db, dir)).toBe(0);

		const stray = join(dir, "zz");
		mkdirSync(stray, { recursive: true });
		writeFileSync(join(stray, "notes.webp"), "x");
		expect(await recordMissingBlobSizes(t.db, dir)).toBe(0);
	});
});

describe("traffic classification", () => {
	test("categories", () => {
		expect(categoryOf("/blobs/ab.webp")).toBe("blobs");
		expect(categoryOf("/api/dimensions/overworld/tiles/0/1/2")).toBe("tiles");
		expect(categoryOf("/api/preview.png")).toBe("preview");
		expect(categoryOf("/api/layers")).toBe("api");
		expect(categoryOf("/auth/discord")).toBe("auth");
		expect(categoryOf("/assets/index.js")).toBe("static");
	});

	test("the domain comes from Origin, then Referer", () => {
		const self = "map.example";
		expect(domainOf("https://Other.Site", undefined, self)).toBe("other.site");
		expect(domainOf(undefined, "https://a.b:8080/page?x=1", self)).toBe(
			"a.b:8080",
		);
		expect(domainOf("https://x.y", "https://z.w/", self)).toBe("x.y");
		expect(domainOf("https://map.example", undefined, self)).toBe(SELF_DOMAIN);
		expect(domainOf("null", "not a url", self)).toBe(NO_REFERRER);
		expect(domainOf(undefined, undefined, self)).toBe(NO_REFERRER);
	});
});

describe("traffic collection", () => {
	test("counts are batched, added up per hour, and attributed to a domain for tiles and blobs only", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 5, 1, 12, 30);
		traffic.record("tiles", "a.com", 0, 302, now);
		traffic.record("blobs", "a.com", 500, 200, now);
		traffic.record("blobs", "a.com", 700, 200, now + 1000);
		traffic.record("api", "a.com", 40, 404, now);
		expect(await t.db.select().from(trafficHourly)).toHaveLength(0);

		traffic.flush(now);
		traffic.record("blobs", "a.com", 100, 200, now);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		const blobs = rows.find((r) => r.category === "blobs");
		expect(blobs).toMatchObject({
			hour: Math.floor(now / MINUTE) * MINUTE,
			domain: "a.com",
			requests: 3,
			bytes: 1300,
			s2xx: 3,
		});
		expect(rows.find((r) => r.category === "api")).toMatchObject({
			domain: "",
			s4xx: 1,
		});
	});

	test("an unbounded number of domains collapses into 'Other'", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 5, 1, 12);
		for (let i = 0; i < 250; i++)
			traffic.record("tiles", `d${i}.com`, 0, 302, now);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		expect(rows).toHaveLength(201);
		expect(rows.find((r) => r.domain === OTHER_DOMAIN)?.requests).toBe(50);
	});

	test("hourly rows past 90 days are folded into days", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 8, 1);
		const day = Date.UTC(2026, 2, 1);
		for (const h of [3, 4, 5])
			traffic.record("api", "", 10, 200, day + h * HOUR);
		traffic.record("api", "", 10, 200, now - HOUR);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		const old = rows.filter((r) => r.hour < now - 90 * DAY);
		expect(old).toHaveLength(1);
		expect(old[0]).toMatchObject({ hour: day, requests: 3, bytes: 30 });
		expect(rows).toHaveLength(2);
	});
});

describe("traffic detail", () => {
	test("rows are per minute for a day, then hourly", async () => {
		const t = await boot();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 5, 10, 12, 0);
		const old = now - 30 * HOUR + 5 * MINUTE;
		traffic.record("api", "", 10, 200, old);
		traffic.record("api", "", 10, 200, old + 2 * MINUTE);
		traffic.record("api", "", 10, 200, now - 5 * MINUTE);
		traffic.record("api", "", 10, 200, now - 5 * MINUTE + 1000);
		traffic.flush(now);
		const rows = await t.db.select().from(trafficHourly);
		expect(rows).toHaveLength(2);
		const folded = rows.find((r) => r.hour % HOUR === 0);
		expect(folded).toMatchObject({
			hour: Math.floor(old / HOUR) * HOUR,
			requests: 2,
		});
		const recent = rows.find((r) => r.hour % HOUR !== 0);
		expect(recent).toMatchObject({ hour: now - 5 * MINUTE, requests: 2 });
	});

	test("the last-hour range has one bucket per minute", async () => {
		const t = await boot();
		await t.app.request("/api/map");
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=1h");
		expect(res.status).toBe(200);
		expect(res.body.traffic.bucketMs).toBe(MINUTE);
		expect(res.body.traffic.points.length).toBeGreaterThanOrEqual(60);
		expect(res.body.traffic.points.length).toBeLessThanOrEqual(62);
		expect(res.body.traffic.range.total.requests).toBeGreaterThanOrEqual(1);
	});

	test("the last-week range has one bucket per three hours", async () => {
		const t = await boot();
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=7d");
		expect(res.body.traffic.bucketMs).toBe(3 * HOUR);
		expect(res.body.traffic.points.length).toBeGreaterThanOrEqual(56);
		expect(res.body.traffic.points.length).toBeLessThanOrEqual(58);
	});

	test("the last-6-hours range has one bucket per five minutes", async () => {
		const t = await boot();
		await t.app.request("/api/map");
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=6h");
		expect(res.status).toBe(200);
		expect(res.body.traffic.bucketMs).toBe(FIVE_MINUTES);
		expect(res.body.traffic.points.length).toBeGreaterThanOrEqual(72);
		expect(res.body.traffic.points.length).toBeLessThanOrEqual(74);
		expect(res.body.traffic.range.total.requests).toBeGreaterThanOrEqual(1);
	});
});

describe("GET /api/admin/stats", () => {
	test("owners only", async () => {
		const t = await boot();
		expect((await call(t, null, "GET", "/api/admin/stats")).status).toBe(401);
		expect((await call(t, t.mod, "GET", "/api/admin/stats")).status).toBe(403);
		const editor = await makeUser(t.db, "someone");
		expect((await call(t, editor, "GET", "/api/admin/stats")).status).toBe(403);
		const invalid = await call(t, t.owner, "GET", "/api/admin/stats?range=1y");
		expect(invalid.status).toBe(400);
		expect(invalid.body.error).toBe("invalid request");
		expect(invalid.body.issues.length).toBeGreaterThan(0);
		expect((await call(t, t.owner, "GET", "/api/admin/stats")).status).toBe(
			200,
		);
	});

	test("reports storage, traffic by domain and an overview", async () => {
		const t = await boot();
		await upload(t, await solid(T, T, RED), 0, 0);
		const tile = await t.app.request("/api/dimensions/overworld/tiles/0/0/0", {
			headers: { Referer: "https://other.example/page" },
		});
		expect(tile.status).toBe(302);
		const blob = await t.app.request(tile.headers.get("location") as string, {
			headers: { Referer: "https://other.example/page" },
		});
		const size = (await blob.arrayBuffer()).byteLength;
		await t.app.request("/api/dimensions/overworld/tiles/0/0/0");

		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=24h");
		expect(res.status).toBe(200);
		const { storage, traffic, overview } = res.body;

		expect(storage.current.blobCount).toBeGreaterThan(0);
		expect(storage.history.length).toBeGreaterThan(0);

		const other = traffic.domains.find(
			(d: { domain: string }) => d.domain === "other.example",
		);
		expect(other).toMatchObject({
			tileRequests: 1,
			blobRequests: 1,
			bytes: size,
		});
		expect(
			traffic.domains.find((d: { domain: string }) => d.domain === NO_REFERRER)
				.tileRequests,
		).toBeGreaterThanOrEqual(1);
		expect(traffic.range.byCategory.blobs.bytes).toBe(size);
		expect(traffic.allTime.total.requests).toBeGreaterThanOrEqual(3);
		expect(traffic.bucketMs).toBe(HOUR);
		expect(traffic.points.length).toBeGreaterThan(0);

		expect(overview.users.total).toBe(3);
		expect(overview.map.uploadsDone).toBe(1);
		expect(overview.tiles.images).toBe(storage.current.blobCount);
		expect(overview.jobs).toMatchObject({ pending: 0, failed: 0 });
		expect(overview.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
	});

	test("server errors are counted apart from client errors", async () => {
		const t = await boot();
		const now = Date.now();
		t.services.traffic.record("api", "", 10, 404, now);
		t.services.traffic.record("api", "", 10, 500, now);
		t.services.traffic.record("api", "", 10, 503, now);
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=24h");
		const { total, byCategory } = res.body.traffic.range;
		expect(total.s4xx).toBe(1);
		expect(total.s5xx).toBe(2);
		expect(byCategory.api.s5xx).toBe(2);
		expect(byCategory.tiles.s5xx).toBe(0);
		expect(res.body.traffic.allTime.total.s5xx).toBe(2);
	});

	test("the all-time range with no traffic yields a short series", async () => {
		const t = await boot();
		const res = await call(t, t.owner, "GET", "/api/admin/stats?range=all");
		expect(res.body.since).toBeNull();
		expect(res.body.traffic.bucketMs).toBe(DAY);
		expect(res.body.traffic.points.length).toBeLessThan(5);
	});
});

import { afterAll, describe, expect, test } from "bun:test";
import { trafficHourly } from "../src/db/schema";
import { createTraffic } from "../src/traffic";
import { bootTiles, cleanupTempDirs, makeTestApp } from "./helpers";

afterAll(cleanupTempDirs);

const apiRows = async (t: { db: ReturnType<typeof makeTestApp>["db"] }) =>
	(await t.db.select().from(trafficHourly)).filter((r) => r.category === "api");
const sum = (rows: { requests: number; bytes: number }[]) => ({
	requests: rows.reduce((n, r) => n + r.requests, 0),
	bytes: rows.reduce((n, r) => n + r.bytes, 0),
});

describe("traffic middleware", () => {
	test("counts the bytes of responses that have no Content-Length as they are sent", async () => {
		const t = await bootTiles();
		const res = await t.app.request("/api/map");
		expect(res.headers.get("content-length")).toBeNull();
		const text = await res.text();
		t.services.traffic.flush();
		expect(sum(await apiRows(t))).toEqual({
			requests: 1,
			bytes: Buffer.byteLength(text),
		});
	});

	test("a response that is never read still counts as a request", async () => {
		const t = await bootTiles();
		const res = await t.app.request("/api/map");
		await res.body?.cancel();
		t.services.traffic.flush();
		expect(sum(await apiRows(t)).requests).toBe(1);
	});

	test("the response is passed on unchanged", async () => {
		const t = await bootTiles();
		const res = await t.app.request("/api/map");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(((await res.json()) as { map: unknown }).map).toBeDefined();
	});
});

describe("traffic counters", () => {
	test("server errors are counted apart from client errors", async () => {
		const t = makeTestApp();
		const traffic = createTraffic(t.db, t.env);
		const now = Date.UTC(2026, 5, 1, 12, 30);
		traffic.record("api", "", 10, 404, now);
		traffic.record("api", "", 10, 500, now);
		traffic.record("api", "", 10, 503, now);
		traffic.flush(now);
		const [row] = await apiRows(t);
		expect(row).toMatchObject({ requests: 3, s4xx: 1, s5xx: 2, s2xx: 0 });
	});

	test("counts are kept when writing them out fails", async () => {
		const t = makeTestApp();
		let broken = true;
		const db = new Proxy(t.db, {
			get(target, prop) {
				if (prop === "transaction" && broken)
					return () => {
						throw new Error("disk full");
					};
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const traffic = createTraffic(db, t.env);
		const now = Date.UTC(2026, 5, 1, 12, 30);
		traffic.record("api", "", 10, 200, now);
		expect(() => traffic.flush(now)).toThrow("disk full");
		traffic.record("api", "", 5, 500, now);
		expect(() => traffic.flush(now)).toThrow("disk full");

		broken = false;
		traffic.flush(now);
		const [row] = await apiRows(t);
		expect(row).toMatchObject({ requests: 2, bytes: 15, s2xx: 1, s5xx: 1 });
	});
});

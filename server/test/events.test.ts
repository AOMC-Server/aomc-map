import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { revisions } from "../src/db/schema";
import type { Envelope } from "../src/events";
import {
	type Auth,
	BLUE,
	bootTiles,
	call,
	cleanupTempDirs,
	erase,
	makeSessionCookie,
	makeUser,
	postUpload,
	RED,
	solid,
	T,
	type TileApp,
	upload,
} from "./helpers";

afterAll(cleanupTempDirs);

const boot = () => bootTiles({}, { owner: true });

const parse = (text: string) =>
	text
		.split("\n\n")
		.map((block) => block.split("\n").find((l) => l.startsWith("data:")))
		.filter((line): line is string => line !== undefined)
		.map((line) => JSON.parse(line.slice(5)) as Envelope);

/**
 * Reads the multiplexed stream until `until` is met (by default one message per topic asked for)
 * or the server ends it, then hangs up. Returns what was read so far.
 */
async function follow(
	t: TileApp,
	topics: string,
	user: Auth = null,
	until: number | ((seen: Envelope[]) => boolean) = topics.split(",").length,
) {
	const enough =
		typeof until === "number"
			? (seen: Envelope[]) => seen.length >= until
			: until;
	const res = await t.app.request(`/api/events?topics=${topics}`, {
		headers: user?.auth,
	});
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let text = "";
	let seen: Envelope[] = [];
	const timeout = setTimeout(() => reader.cancel(), 5000);
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			seen = parse(text);
			if (enough(seen)) break;
		}
	} finally {
		clearTimeout(timeout);
		await reader.cancel().catch(() => {});
	}
	return seen;
}

/** The ids of the two dimensions every map starts with. */
async function dimensionIds(t: TileApp) {
	const { body } = await call(t, null, "GET", "/api/map");
	const idOf = (slug: string) =>
		body.dimensions.find((d: { slug: string }) => d.slug === slug).id as number;
	return { overworld: idOf("overworld"), nether: idOf("nether") };
}

describe("GET /api/events", () => {
	test("sends the current state of every topic first", async () => {
		const t = await boot();
		const { overworld } = await dimensionIds(t);
		const seen = await follow(
			t,
			`map,queue,layers:${overworld},revisions:${overworld},recompute`,
			t.owner,
		);
		expect(seen).toHaveLength(5);
		for (const envelope of seen) {
			expect(envelope).toMatchObject({ snapshot: true });
			expect("final" in envelope).toBe(false);
		}
		const byTopic = Object.fromEntries(
			seen.map((e) => [e.topic, "data" in e ? e.data : null]),
		);
		expect(byTopic.map).toEqual({ headRev: 0, epoch: 0, maintenance: false });
		expect(byTopic.queue).toEqual({ pending: 0, running: null });
		expect(byTopic[`layers:${overworld}`]).toEqual({});
		expect(byTopic[`revisions:${overworld}`]).toEqual({});
		expect(byTopic.recompute).toEqual({ recompute: null });
	});

	test("says why a topic cannot be followed", async () => {
		const t = await boot();
		const asEditor = await follow(
			t,
			"nonsense,layers:999999,layers,layers:abc,map:1,recompute",
			t.editor,
		);
		expect(asEditor).toEqual([
			{ topic: "nonsense", error: "unknown topic" },
			{ topic: "layers:999999", error: "not found" },
			{ topic: "layers", error: "unknown topic" },
			{ topic: "layers:abc", error: "unknown topic" },
			{ topic: "map:1", error: "unknown topic" },
			{ topic: "recompute", error: "forbidden" },
		]);
		const anonymous = await follow(t, "recompute", null);
		expect(anonymous).toEqual([{ topic: "recompute", error: "forbidden" }]);
	});

	test("ends right away when nothing can be followed", async () => {
		const t = await boot();
		const res = await t.app.request("/api/events?topics=nope,layers:999999");
		expect(parse(await res.text())).toHaveLength(2);
		expect(parse(await (await t.app.request("/api/events")).text())).toEqual(
			[],
		);
	});

	test("owners may follow the recompute", async () => {
		const t = await boot();
		const [envelope] = await follow(t, "recompute", t.owner);
		expect(envelope).toMatchObject({
			topic: "recompute",
			snapshot: true,
			data: { recompute: null },
		});
		const moderator = await follow(t, "recompute", t.mod);
		expect(moderator).toEqual([{ topic: "recompute", error: "forbidden" }]);
	});

	test("a finished revision is one final snapshot, and the stream ends", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const res = await t.app.request(`/api/events?topics=revision:${id}`);
		const seen = parse(await res.text());
		expect(seen).toEqual([
			{
				topic: `revision:${id}`,
				seq: expect.any(String),
				snapshot: true,
				final: true,
				data: { status: "done", rev: 1, error: null },
			},
		]);
	});

	test("the stream stays open for the topics that are not done", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const { overworld } = await dimensionIds(t);
		const seen = await follow(t, `revision:${id},layers:${overworld}`, null);
		expect(seen.map((e) => e.topic).sort()).toEqual(
			[`layers:${overworld}`, `revision:${id}`].sort(),
		);
		// The revision ended; the layers are still followed.
		const done = seen.find((e) => e.topic === `revision:${id}`);
		expect(done).toMatchObject({ final: true });
	});

	test("deleting an upload ends its revision topic with gone", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const res = await call(t, t.mod, "DELETE", `/api/revisions/${id}`);
		expect(res.status).toBe(202);
		const stream = t.app.request(`/api/events?topics=revision:${id}`);
		await t.services.worker.run();
		const seen = parse(await (await stream).text());
		const last = seen.at(-1);
		expect(last).toMatchObject({
			topic: `revision:${id}`,
			final: true,
			data: { status: "gone" },
		});
		// Nothing but the snapshot can come before it.
		expect(seen.filter((e) => "final" in e)).toHaveLength(1);
	});

	test("a revision that was erased, or never existed, is gone", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		await erase(t, id);
		for (const key of [id, 424242]) {
			const [envelope] = await follow(t, `revision:${key}`);
			expect(envelope).toMatchObject({
				topic: `revision:${key}`,
				data: { status: "gone" },
				final: true,
			});
		}
	});

	test("seq counts a topic's events, and a snapshot carries the last one", async () => {
		const t = await boot();
		const { overworld } = await dimensionIds(t);
		const { events } = t.services;
		const topic = `layers:${overworld}`;
		const [first] = await follow(t, topic);
		const boot0 = (first as { seq: string }).seq.split(".")[0];
		expect(first).toMatchObject({ seq: `${boot0}.0`, snapshot: true });

		events.emit("layers", overworld, {});
		events.emit("layers", overworld, {});
		const [second] = await follow(t, topic);
		expect(second).toMatchObject({ seq: `${boot0}.2`, snapshot: true });

		const res = await t.app.request(`/api/events?topics=${topic}`);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let text = "";
		while (parse(text).length < 1) {
			text += decoder.decode((await reader.read()).value);
		}
		events.emit("layers", overworld, {});
		while (parse(text).length < 2) {
			text += decoder.decode((await reader.read()).value);
		}
		await reader.cancel();
		expect(parse(text)).toMatchObject([
			{ seq: `${boot0}.2`, snapshot: true },
			{ seq: `${boot0}.3`, snapshot: false, data: {} },
		]);
	});
});

describe("a waiting revision", () => {
	test("is announced again when the queue in front of it moves", async () => {
		const t = await boot();
		await upload(t, await solid(T, T, RED), 0, 0);
		expect(
			(await call(t, t.owner, "POST", "/api/admin/history/recompute")).status,
		).toBe(202);
		const res = await postUpload(t, t.editor, [
			{ name: "b_x0_z0.png", data: await solid(T, T, BLUE) },
		]);
		const { revisionId } = (await res.json()) as { revisionId: number };

		const stream = follow(t, `revision:${revisionId},queue`, null, (s) =>
			s.some(
				(e) =>
					e.topic === `revision:${revisionId}` &&
					"data" in e &&
					(e.data as { status: string }).status === "done",
			),
		);
		await t.services.worker.run();
		const seen = await stream;
		const mine = seen.filter((e) => e.topic === `revision:${revisionId}`);
		expect(mine[0]).toMatchObject({
			snapshot: true,
			data: { status: "pending" },
		});
		expect(mine.at(-1)).toMatchObject({
			data: { status: "done" },
			final: true,
		});
		const queue = seen.filter((e) => e.topic === "queue");
		expect(queue[0]).toMatchObject({
			snapshot: true,
			data: { pending: expect.any(Number) },
		});
	});

	test("its first state says what it waits for", async () => {
		const t = await boot();
		await upload(t, await solid(T, T, RED), 0, 0);
		await call(t, t.owner, "POST", "/api/admin/history/recompute");
		const res = await postUpload(t, t.editor, [
			{ name: "b_x0_z0.png", data: await solid(T, T, BLUE) },
		]);
		const { revisionId } = (await res.json()) as { revisionId: number };
		const [first] = await follow(t, `revision:${revisionId}`);
		expect(first).toMatchObject({
			snapshot: true,
			data: {
				status: "pending",
				message: "Waiting for the history recompute to finish",
			},
		});
		await t.services.worker.run();
	});

	test("the queue topic follows jobs as they come and go", async () => {
		const t = await boot();
		const seen: unknown[] = [];
		t.services.events.subscribe("queue", (data) => seen.push(data));
		await upload(t, await solid(T, T, RED), 0, 0);
		expect(seen[0]).toEqual({ pending: 1, running: null });
		expect(seen).toContainEqual({
			pending: 0,
			running: { type: "process_upload", revisionId: 1 },
		});
		expect(seen.at(-1)).toEqual({ pending: 0, running: null });
	});
});

describe("GET /api/revisions/:id/events", () => {
	test("names its events after the status", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		const text = await (
			await t.app.request(`/api/revisions/${id}/events`)
		).text();
		expect(text).toContain("event: done");
		expect(text).toContain('"rev":1');
		expect(text).not.toContain("snapshot");
	});

	test("a delete ends with gone", async () => {
		const t = await boot();
		const id = await upload(t, await solid(T, T, RED), 0, 0);
		await call(t, t.mod, "DELETE", `/api/revisions/${id}`);
		const stream = t.app.request(`/api/revisions/${id}/events`);
		await t.services.worker.run();
		const text = await (await stream).text();
		expect(text).toContain("event: gone");
	});

	test("answers 404 for an unknown revision", async () => {
		const t = await boot();
		expect((await t.app.request("/api/revisions/9999/events")).status).toBe(
			404,
		);
		expect((await t.app.request("/api/revisions/abc/events")).status).toBe(404);
	});
});

type Seen = { topic: string; data: unknown };

/** Runs `action` and returns what the hub announced meanwhile, for the topics of interest. */
async function announced(
	t: TileApp,
	topics: string[],
	action: () => Promise<unknown>,
) {
	const seen: Seen[] = [];
	const undo = topics.map((topic) =>
		t.services.events.subscribe(topic, (data) => seen.push({ topic, data })),
	);
	try {
		await action();
	} finally {
		for (const fn of undo) fn();
	}
	return seen;
}

describe("routes announce what they change", async () => {
	const t = await boot();
	const dims = await dimensionIds(t);
	const ow = dims.overworld;
	const nether = dims.nether;
	const watched = [
		"map",
		"recompute",
		`layers:${ow}`,
		`layers:${nether}`,
		`revisions:${ow}`,
		`revisions:${nether}`,
	];
	const everything = [
		"map",
		`layers:${ow}`,
		`layers:${nether}`,
		`revisions:${ow}`,
		`revisions:${nether}`,
	];
	const run = (user: Auth, method: string, path: string, body?: unknown) =>
		announced(t, watched, () => call(t, user, method, path, body));
	const topicsOf = (seen: Seen[]) => seen.map((s) => s.topic);
	const browser = async (id: string) => ({
		auth: {
			Cookie: await makeSessionCookie(t.db, id),
			Origin: "http://localhost:3000",
		},
	});

	const makeLayer = async (extra: object = {}) =>
		(
			await call(t, t.editor, "POST", "/api/layers", {
				dimension: "overworld",
				name: "Bases",
				color: "red",
				...extra,
			})
		).body.layer.id as number;
	const pin = (name = "Base") => ({ type: "pin", name, geometry: [1, 2] });
	const makeFeature = async (layer: number) =>
		(await call(t, t.editor, "POST", `/api/layers/${layer}/features`, pin()))
			.body.feature as { id: number; revisionId: number };

	test("an upload announces the upload log", async () => {
		const seen = await announced(t, watched, async () => {
			const res = await postUpload(t, t.editor, [
				{ name: "a_x0_z0.png", data: await solid(T, T, RED) },
			]);
			expect(res.status).toBe(202);
		});
		expect(topicsOf(seen)).toContain(`revisions:${ow}`);
		await t.services.worker.run();
	});

	test("deleting a failed upload announces it gone and the upload log", async () => {
		const id = await upload(t, await solid(T, T, BLUE), 32, 32);
		t.db
			.update(revisions)
			.set({ status: "failed", error: "boom" })
			.where(eq(revisions.id, id))
			.run();
		const seen = await announced(t, [...watched, `revision:${id}`], () =>
			call(t, t.mod, "DELETE", `/api/revisions/${id}`),
		);
		expect(seen).toContainEqual({
			topic: `revision:${id}`,
			data: { status: "gone" },
		});
		expect(topicsOf(seen)).toContain(`revisions:${ow}`);
		await t.services.worker.run();
	});

	test("queueing the delete of an upload announces the upload log and the queue", async () => {
		const id = await upload(t, await solid(T, T, RED), 64, 64);
		const queue: unknown[] = [];
		const stop = t.services.events.subscribe("queue", (q) => queue.push(q));
		const seen = await run(t.mod, "DELETE", `/api/revisions/${id}`);
		stop();
		expect(topicsOf(seen)).toContain(`revisions:${ow}`);
		expect(queue[0]).toMatchObject({ pending: 1 });
		await t.services.worker.run();
	});

	test("starting a recompute announces it", async () => {
		const seen = await run(t.owner, "POST", "/api/admin/history/recompute");
		expect(seen.filter((s) => s.topic === "recompute")[0]).toEqual({
			topic: "recompute",
			data: {
				recompute: {
					status: "pending",
					error: null,
					queuedAt: expect.any(Number),
					completedAt: null,
					progress: null,
				},
			},
		});
		await t.services.worker.run();
	});

	test("the history shows what the stream does", async () => {
		const history = await call(t, t.owner, "GET", "/api/admin/history");
		const [envelope] = await follow(t, "recompute", t.owner);
		expect(history.body.recompute).toEqual(
			(envelope as { data: { recompute: unknown } }).data.recompute,
		);
		expect(history.body.recompute).toMatchObject({ status: "done" });
		expect(Object.keys(history.body).sort()).toEqual([
			"lateUploads",
			"recompute",
		]);
	});

	test("changing the map settings announces the map", async () => {
		expect(await run(t.owner, "PATCH", "/api/map", { name: "y" })).toEqual([
			{
				topic: "map",
				data: {
					headRev: expect.any(Number),
					epoch: expect.any(Number),
					maintenance: false,
				},
			},
		]);
		expect(await run(t.mod, "PATCH", "/api/map", { name: "x" })).toEqual([]);
	});

	test("maintenance also announces every layer list and upload log", async () => {
		const seen = await run(t.owner, "PATCH", "/api/map", { maintenance: true });
		await call(t, t.owner, "PATCH", "/api/map", { maintenance: false });
		expect(seen[0]).toMatchObject({
			topic: "map",
			data: { maintenance: true },
		});
		const topics = topicsOf(seen);
		expect(topics).toContain("layers:1");
		expect(topics).toContain("revisions:1");
	});

	test("dimensions announce the map", async () => {
		const create = { slug: "end", name: "The End" };
		expect(
			topicsOf(await run(t.mod, "POST", "/api/dimensions", create)),
		).toEqual(["map"]);
		for (const change of [
			{ archived: true },
			{ sortOrder: 0 },
			{ name: "E" },
		]) {
			expect(
				topicsOf(await run(t.mod, "PATCH", "/api/dimensions/end", change)),
			).toEqual(["map"]);
		}
		expect(await run(t.mod, "PATCH", "/api/dimensions/nope", {})).toEqual([]);
		expect(await run(t.mod, "POST", "/api/dimensions", create)).toEqual([]);
		expect(await run(t.editor, "POST", "/api/dimensions", create)).toEqual([]);
	});

	test("layers announce their dimension", async () => {
		const only = [`layers:${ow}`];
		const created = await run(t.editor, "POST", "/api/layers", {
			dimension: "overworld",
			name: "One",
			color: "red",
		});
		expect(topicsOf(created)).toEqual(only);
		expect(
			topicsOf(
				await run(t.editor, "POST", "/api/layers", {
					dimension: "nether",
					name: "Two",
					color: "red",
				}),
			),
		).toEqual([`layers:${nether}`]);

		const ids = (
			await call(t, t.editor, "GET", "/api/layers?dim=overworld")
		).body.layers.map((l: { id: number }) => l.id) as number[];
		const layer = ids[0] as number;
		expect(
			topicsOf(
				await run(t.editor, "PATCH", `/api/layers/${layer}`, { name: "New" }),
			),
		).toEqual(only);
		expect(
			topicsOf(
				await run(t.editor, "POST", "/api/layers/reorder", {
					dimension: "overworld",
					ids: [...ids].reverse(),
				}),
			),
		).toEqual(only);
		expect(
			await run(t.editor, "POST", "/api/layers/reorder", {
				dimension: "overworld",
				ids: [999999],
			}),
		).toEqual([]);
		expect(
			topicsOf(await run(t.editor, "DELETE", `/api/layers/${layer}`)),
		).toEqual(only);
		expect(await run(t.editor, "DELETE", `/api/layers/${layer}`)).toEqual([]);
		expect(await run(t.editor, "PATCH", `/api/layers/${layer}`, {})).toEqual(
			[],
		);
	});

	test("features announce their layer's dimension", async () => {
		const layer = await makeLayer();
		const only = [`layers:${ow}`];
		const feature = `/api/layers/${layer}/features`;
		expect(
			topicsOf(await run(t.editor, "POST", feature, pin("Added"))),
		).toEqual(only);
		const first = await makeFeature(layer);
		const second = await makeFeature(layer);

		expect(
			topicsOf(
				await run(t.editor, "PATCH", `/api/features/${first.id}`, {
					name: "B",
				}),
			),
		).toEqual(only);
		expect(
			await run(t.editor, "PATCH", `/api/features/${first.id}`, {
				baseRevisionId: first.revisionId,
				name: "stale",
			}),
		).toEqual([]);

		const restore = `/api/features/${second.id}/restore/${second.revisionId}`;
		// The current version restored again changes nothing.
		expect(await run(t.mod, "POST", restore)).toEqual([]);
		expect(
			topicsOf(await run(t.editor, "DELETE", `/api/features/${second.id}`)),
		).toEqual(only);
		expect(await run(t.editor, "DELETE", `/api/features/${second.id}`)).toEqual(
			[],
		);
		expect(topicsOf(await run(t.mod, "POST", restore))).toEqual(only);

		const live = (
			await call(t, t.editor, "GET", "/api/layers?dim=overworld")
		).body.layers.find((l: { id: number }) => l.id === layer).features as {
			id: number;
		}[];
		expect(
			topicsOf(
				await run(t.editor, "POST", `${feature}/reorder`, {
					ids: live.map((f) => f.id).reverse(),
				}),
			),
		).toEqual(only);
		expect(
			await run(t.editor, "POST", `${feature}/reorder`, { ids: [first.id] }),
		).toEqual([]);
		expect(
			topicsOf(
				await run(t.editor, "POST", `/api/layers/${layer}/import`, [pin("I")]),
			),
		).toEqual(only);
		expect(
			topicsOf(
				await run(
					t.editor,
					"POST",
					`/api/layers/${layer}/import?replace=1`,
					[],
				),
			),
		).toEqual(only);
	});

	test("layer members announce the layer's dimension", async () => {
		const layer = await makeLayer({ visibility: "private" });
		const friend = await makeUser(t.db, "friend");
		const path = `/api/layers/${layer}/members`;
		const only = [`layers:${ow}`];
		expect(
			topicsOf(
				await run(t.editor, "POST", path, {
					userId: friend.id,
					role: "viewer",
				}),
			),
		).toEqual(only);
		expect(
			topicsOf(
				await run(t.editor, "PATCH", `${path}/${friend.id}`, {
					role: "editor",
				}),
			),
		).toEqual(only);
		expect(
			await run(t.editor, "PATCH", `${path}/nobody`, { role: "editor" }),
		).toEqual([]);
		expect(
			topicsOf(await run(friend, "DELETE", `${path}/${friend.id}`)),
		).toEqual(only);
		expect(await run(friend, "DELETE", `${path}/${friend.id}`)).toEqual([]);
	});

	test("accepting a layer invite announces the layer's dimension, once", async () => {
		const layer = await makeLayer({ visibility: "private" });
		const make = () =>
			run(t.editor, "POST", `/api/layers/${layer}/invites`, { role: "viewer" });
		const invite = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer}/invites`,
			{ role: "viewer" },
		);
		const guest = await makeUser(t.db, "guest");
		const path = `/api/invites/${invite.body.token}/accept`;
		expect(topicsOf(await run(guest, "POST", path))).toEqual([`layers:${ow}`]);
		expect(await run(guest, "POST", path)).toEqual([]);
		// An invite that nobody has used changes nothing anyone sees.
		expect(await make()).toEqual([]);
	});

	test("roles announce the map and every dimension", async () => {
		const person = await makeUser(t.db, "person");
		const everyone = (seen: Seen[]) => [...new Set(topicsOf(seen))].sort();
		const expected = [...everything].sort();
		expect(
			everyone(
				await run(t.owner, "POST", "/api/members", {
					userId: person.id,
					role: "moderator",
				}),
			),
		).toEqual(expected);
		expect(
			everyone(
				await run(t.owner, "PATCH", `/api/members/${person.id}`, {
					role: "owner",
				}),
			),
		).toEqual(expected);
		expect(
			everyone(await run(t.owner, "DELETE", `/api/members/${person.id}`)),
		).toEqual(expected);
		expect(await run(t.owner, "DELETE", `/api/members/${person.id}`)).toEqual(
			[],
		);
		expect(
			await run(t.editor, "POST", "/api/members", {
				userId: person.id,
				role: "owner",
			}),
		).toEqual([]);
	});

	test("accepting a map invite announces the roles, once", async () => {
		const invite = await call(t, t.owner, "POST", "/api/invites", {});
		const newcomer = await makeUser(t.db, "newcomer");
		const me = await browser(newcomer.id);
		const path = `/api/invites/${invite.body.token}/accept`;
		const seen = await run(me, "POST", path);
		expect([...new Set(topicsOf(seen))].sort()).toEqual([...everything].sort());
		expect(await run(me, "POST", path)).toEqual([]);
	});

	test("deleting your account announces the map and every dimension", async () => {
		const leaving = await makeUser(t.db, "leaving");
		const seen = await run(await browser(leaving.id), "DELETE", "/api/me");
		expect([...new Set(topicsOf(seen))].sort()).toEqual([...everything].sort());
		expect(await run(t.editor, "DELETE", "/api/me")).toEqual([]);
	});
});

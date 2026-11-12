import { describe, expect, test } from "bun:test";
import { createEventStream, type StreamOptions } from "./events";

class FakeSource {
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	onopen: ((e: Event) => void) | null = null;
	closed = false;
	constructor(readonly url: string) {}
	close() {
		this.closed = true;
	}
	send(envelope: object) {
		this.onmessage?.({ data: JSON.stringify(envelope) } as MessageEvent);
	}
	break() {
		this.onerror?.(new Event("error"));
	}
	get topics() {
		return new URL(this.url, "http://x").searchParams.get("topics");
	}
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(opts: StreamOptions = {}) {
	const sources: FakeSource[] = [];
	const stream = createEventStream({
		batchMs: 1,
		silenceMs: 1000,
		retryMs: () => 5,
		...opts,
		open: (url) => {
			const s = new FakeSource(url);
			sources.push(s);
			return s;
		},
	});
	return {
		stream,
		sources,
		get current() {
			const s = sources.at(-1);
			if (!s) throw new Error("no stream was opened");
			return s;
		},
	};
}

const snap = (topic: string, seq: string, data: object = {}) => ({
	topic,
	seq,
	snapshot: true,
	data,
});
const event = (topic: string, seq: string, data: object = {}) => ({
	topic,
	seq,
	snapshot: false,
	data,
});

describe("createEventStream", () => {
	test("batches subscriptions made together into one connection", async () => {
		const t = setup();
		t.stream.subscribe("map", { onEvent: () => {} });
		t.stream.subscribe("layers:2", { onEvent: () => {} });
		t.stream.subscribe("revision:7", { onEvent: () => {} });
		await wait(10);
		expect(t.sources).toHaveLength(1);
		expect(t.current.topics).toBe("layers:2,map,revision:7");
	});

	test("delivers each event to the subscribers of its topic", async () => {
		const t = setup();
		const got: [unknown, boolean][] = [];
		const other: unknown[] = [];
		t.stream.subscribe("layers:2", {
			onEvent: (d, m) => got.push([d, m.snapshot]),
		});
		t.stream.subscribe("layers:3", { onEvent: (d) => other.push(d) });
		await wait(10);
		t.current.send(snap("layers:2", "a.0"));
		t.current.send(event("layers:2", "a.1"));
		expect(got).toEqual([
			[{}, true],
			[{}, false],
		]);
		expect(other).toEqual([]);
	});

	test("skips a snapshot that repeats after reconnecting, but not a changed one", async () => {
		const t = setup();
		const got: unknown[] = [];
		t.stream.subscribe("map", { onEvent: (d) => got.push(d) });
		await wait(10);
		const data = { headRev: 1, epoch: 0, maintenance: false };
		t.sources[0]?.send(snap("map", "a.3", data));
		t.sources[0]?.break();
		await wait(20);
		expect(t.sources).toHaveLength(2);
		t.sources[1]?.send(snap("map", "a.3", data));
		expect(got).toHaveLength(1);
		// Missed events: a new seq (and data) comes with the snapshot.
		t.sources[1]?.break();
		await wait(20);
		t.sources[2]?.send(snap("map", "a.5", { ...data, headRev: 2 }));
		expect(got).toHaveLength(2);
	});

	test("a repeated snapshot still reaches a subscriber that joined later", async () => {
		const t = setup();
		const first: unknown[] = [];
		const late: unknown[] = [];
		t.stream.subscribe("layers:2", { onEvent: (d) => first.push(d) });
		await wait(10);
		t.sources[0]?.send(snap("layers:2", "a.0"));
		t.sources[0]?.break();
		await wait(0);
		t.stream.subscribe("layers:2", { onEvent: (d) => late.push(d) });
		await wait(20);
		t.sources[1]?.send(snap("layers:2", "a.0"));
		expect(first).toHaveLength(1);
		expect(late).toHaveLength(1);
	});

	test("a final event ends the topic, and it can be followed again", async () => {
		const t = setup();
		const got: unknown[] = [];
		t.stream.subscribe("revision:7", { onEvent: (d) => got.push(d) });
		t.stream.subscribe("map", { onEvent: () => {} });
		await wait(10);
		t.current.send({
			...event("revision:7", "a.2", { status: "done" }),
			final: true,
		});
		t.current.send(event("revision:7", "a.3", { status: "done" }));
		expect(got).toHaveLength(1);

		t.stream.subscribe("revision:7", { onEvent: (d) => got.push(d) });
		await wait(10);
		expect(t.sources).toHaveLength(2);
		expect(t.current.topics).toBe("map,revision:7");
		t.current.send(snap("revision:7", "a.2", { status: "gone" }));
		expect(got).toHaveLength(2);
	});

	test("an error envelope calls onError once and drops the topic", async () => {
		const t = setup();
		const errors: string[] = [];
		const events: unknown[] = [];
		t.stream.subscribe("revision:9", {
			onEvent: (d) => events.push(d),
			onError: (e) => errors.push(e),
		});
		await wait(10);
		t.current.send({ topic: "revision:9", error: "not found" });
		t.current.send(event("revision:9", "a.1", { status: "done" }));
		expect(errors).toEqual(["not found"]);
		expect(events).toEqual([]);
	});

	test("polls while the stream is broken and stops once events flow again", async () => {
		const t = setup();
		let polls = 0;
		t.stream.subscribe("map", {
			onEvent: () => {},
			poll: () => {
				polls++;
			},
			pollMs: 5,
		});
		await wait(10);
		expect(polls).toBe(0);
		t.current.break();
		expect(polls).toBe(1);
		await wait(40);
		expect(polls).toBeGreaterThan(2);
		expect(t.sources.length).toBeGreaterThan(1);

		t.current.send(snap("map", "a.0", { headRev: 1 }));
		expect(t.stream.healthy).toBe(true);
		const stopped = polls;
		await wait(30);
		expect(polls).toBe(stopped);
	});

	test("polls when the stream stays silent, as behind a buffering proxy", async () => {
		const t = setup({ silenceMs: 15 });
		let polls = 0;
		t.stream.subscribe("map", {
			onEvent: () => {},
			poll: () => {
				polls++;
			},
			pollMs: 1000,
		});
		await wait(10);
		expect(polls).toBe(0);
		await wait(25);
		expect(polls).toBe(1);
		expect(t.sources[0]?.closed).toBe(true);
	});

	test("a topic added later reconnects with all of them", async () => {
		const t = setup();
		t.stream.subscribe("map", { onEvent: () => {} });
		await wait(10);
		t.stream.subscribe("queue", { onEvent: () => {} });
		await wait(10);
		expect(t.sources).toHaveLength(2);
		expect(t.sources[0]?.closed).toBe(true);
		expect(t.current.topics).toBe("map,queue");
	});

	test("a second subscriber of a topic already streaming starts from its last event", async () => {
		const t = setup();
		t.stream.subscribe("map", { onEvent: () => {} });
		await wait(10);
		t.current.send(snap("map", "a.0", { headRev: 4 }));
		const got: unknown[] = [];
		t.stream.subscribe("map", {
			onEvent: (d, m) => got.push([d, m.snapshot]),
		});
		await wait(10);
		expect(t.sources).toHaveLength(1);
		expect(got).toEqual([[{ headRev: 4 }, true]]);
	});

	test("hangs up when the last subscriber leaves", async () => {
		const t = setup();
		const a = t.stream.subscribe("map", { onEvent: () => {} });
		const b = t.stream.subscribe("map", { onEvent: () => {} });
		await wait(10);
		a();
		expect(t.current.closed).toBe(false);
		b();
		expect(t.current.closed).toBe(true);
		await wait(20);
		expect(t.sources).toHaveLength(1);
	});

	test("an unsubscribed subscriber hears nothing more", async () => {
		const t = setup();
		const got: unknown[] = [];
		const off = t.stream.subscribe("layers:1", {
			onEvent: (d) => got.push(d),
		});
		t.stream.subscribe("map", { onEvent: () => {} });
		await wait(10);
		off();
		t.current.send(event("layers:1", "a.1"));
		expect(got).toEqual([]);
	});
});

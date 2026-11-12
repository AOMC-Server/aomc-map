import type { DataOf, Envelope, Topic } from "../../server/src/events";

export type { DataOf, Topic };

export type Subscription<T extends Topic> = {
	/** Each event of the topic. `snapshot` = its current state, sent on (re)connecting. */
	onEvent: (data: DataOf<T>, meta: { snapshot: boolean }) => void;
	/** The server will not stream it (unknown, not found, or not yours to follow); it is dropped. */
	onError?: (error: "not found" | "forbidden" | "unknown topic") => void;
	/**
	 * Called while the stream is down (right away, then every `pollMs`), so the subscriber can
	 * poll instead. It stops once the stream works again.
	 */
	poll?: () => void;
	pollMs?: number;
};

type Source = Pick<EventSource, "close" | "onmessage" | "onerror" | "onopen">;

export type StreamOptions = {
	/** Opens the stream; replaceable for tests. */
	open?: (url: string) => Source;
	/** How long to wait to batch subscriptions into one connection. */
	batchMs?: number;
	/** Without a first event this long after connecting, a proxy is probably buffering. */
	silenceMs?: number;
	retryMs?: (attempt: number) => number;
};

const DEFAULT_POLL_MS = 30_000;

/**
 * One server-sent event stream (`GET /api/events`) shared by everything that follows live
 * updates. Subscribers add and remove topics; the stream reconnects when a new one is added,
 * skips snapshots that repeat what was already delivered, and falls back to each subscriber's
 * `poll` while it is down.
 */
export function createEventStream(opts: StreamOptions = {}) {
	const open = opts.open ?? ((url: string) => new EventSource(url));
	const batchMs = opts.batchMs ?? 30;
	const silenceMs = opts.silenceMs ?? 10_000;
	const retryMs =
		opts.retryMs ?? ((n: number) => Math.min(1000 * 2 ** n, 30_000));

	// biome-ignore lint/suspicious/noExplicitAny: each topic has its own data type
	const subs = new Map<string, Set<Subscription<any>>>();
	/** The last event delivered per topic, to tell a repeated snapshot apart. */
	const last = new Map<string, { seq: string; json: string }>();
	/** Subscribers that have been given an event, so a late one still gets a snapshot that repeats. */
	const seen = new WeakSet<object>();
	let source: Source | null = null;
	/** The topics the open stream was asked for. */
	let streaming = new Set<string>();
	let healthy = false;
	/** The stream broke and has not delivered anything since. */
	let isDown = false;
	let attempt = 0;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	let silenceTimer: ReturnType<typeof setTimeout> | undefined;
	let pollTimers = new Map<
		Subscription<Topic>,
		ReturnType<typeof setInterval>
	>();

	const stopPolling = () => {
		for (const timer of pollTimers.values()) clearInterval(timer);
		pollTimers = new Map();
	};
	const startPolling = (sub: Subscription<Topic>) => {
		if (!sub.poll || pollTimers.has(sub)) return;
		sub.poll();
		pollTimers.set(
			sub,
			setInterval(() => sub.poll?.(), sub.pollMs ?? DEFAULT_POLL_MS),
		);
	};
	const down = () => {
		healthy = false;
		isDown = true;
		for (const set of subs.values()) for (const sub of set) startPolling(sub);
	};

	const close = () => {
		clearTimeout(silenceTimer);
		source?.close();
		source = null;
		streaming = new Set();
	};

	const connect = () => {
		clearTimeout(connectTimer);
		close();
		const topics = [...subs.keys()].sort();
		if (topics.length === 0) {
			stopPolling();
			return;
		}
		streaming = new Set(topics);
		const s = open(`/api/events?topics=${topics.join(",")}`);
		source = s;
		silenceTimer = setTimeout(() => {
			if (source === s) fail();
		}, silenceMs);
		s.onmessage = (e: MessageEvent) => {
			if (source !== s) return;
			clearTimeout(silenceTimer);
			if (!healthy) {
				healthy = true;
				isDown = false;
				attempt = 0;
				stopPolling();
			}
			receive(JSON.parse(e.data) as Envelope);
		};
		s.onerror = () => {
			if (source === s) fail();
		};
	};

	/** The stream broke (or ended because every topic in it finished): poll, and try again. */
	const fail = () => {
		close();
		if (subs.size === 0) return;
		down();
		clearTimeout(connectTimer);
		connectTimer = setTimeout(connect, retryMs(attempt++));
	};

	/** The server no longer streams the topic: forget it and its subscribers. */
	const forget = (topic: string) => {
		const set = subs.get(topic);
		subs.delete(topic);
		last.delete(topic);
		// The stream no longer carries it, so following it again needs a new connection.
		streaming.delete(topic);
		for (const sub of set ?? []) {
			clearInterval(pollTimers.get(sub));
			pollTimers.delete(sub);
		}
		return set;
	};

	const receive = (envelope: Envelope) => {
		if ("error" in envelope) {
			for (const sub of forget(envelope.topic) ?? [])
				sub.onError?.(envelope.error);
			return;
		}
		const set = subs.get(envelope.topic);
		// Nobody follows it any more (the stream may still carry it until the next connection).
		if (!set) return;
		const json = JSON.stringify(envelope.data);
		const prev = last.get(envelope.topic);
		const repeat =
			envelope.snapshot && prev?.seq === envelope.seq && prev.json === json;
		// A repeated snapshot is only news to a subscriber that joined after the original.
		const targets = [...set].filter((sub) => !repeat || !seen.has(sub));
		last.set(envelope.topic, { seq: envelope.seq, json });
		if (envelope.final) forget(envelope.topic);
		for (const sub of targets) {
			seen.add(sub);
			sub.onEvent(envelope.data as never, { snapshot: envelope.snapshot });
		}
	};

	const schedule = () => {
		clearTimeout(connectTimer);
		connectTimer = setTimeout(connect, batchMs);
	};

	return {
		subscribe<T extends Topic>(topic: T, sub: Subscription<T>): () => void {
			const set = subs.get(topic) ?? new Set();
			subs.set(topic, set);
			set.add(sub);
			const known = last.get(topic);
			if (streaming.has(topic) && healthy && known) {
				// Already streaming: the new subscriber starts from the last event.
				queueMicrotask(() => {
					if (!set.has(sub)) return;
					seen.add(sub);
					sub.onEvent(JSON.parse(known.json), { snapshot: true });
				});
			} else if (!streaming.has(topic)) {
				schedule();
			}
			if (isDown) startPolling(sub as Subscription<Topic>);
			return () => {
				set.delete(sub);
				clearInterval(pollTimers.get(sub as Subscription<Topic>));
				pollTimers.delete(sub as Subscription<Topic>);
				// A topic that ended may have been followed again since, with a set of its own.
				if (set.size > 0 || subs.get(topic) !== set) return;
				subs.delete(topic);
				last.delete(topic);
				// Following it again needs a new snapshot, so a new connection.
				streaming.delete(topic);
				// Nothing left to follow: hang up. Otherwise the stream may carry an extra topic
				// until the next one is added.
				if (subs.size === 0) {
					clearTimeout(connectTimer);
					close();
					stopPolling();
					healthy = false;
					isDown = false;
				}
			};
		},
		/** Whether the stream delivers events right now. */
		get healthy() {
			return healthy;
		},
	};
}

export type EventStream = ReturnType<typeof createEventStream>;

/** The stream the app shares. */
export const events = createEventStream();

/** Follows a topic on the shared stream. Returns a function that stops following it. */
export const subscribe = <T extends Topic>(topic: T, sub: Subscription<T>) =>
	events.subscribe(topic, sub);

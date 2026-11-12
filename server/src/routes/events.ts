import { type Context, Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import {
	type Envelope,
	type Events,
	type Family,
	keyedFamilies,
	type Topic,
	topicOf,
} from "../events";
import { doc } from "../openapi";
import { type TopicDef, topics } from "../topics";
import type { AppEnv } from "../types";

const MAX_TOPICS = 64;
const PING_MS = 20_000;

type Parsed =
	| { ok: true; topic: Topic; family: Family; key: number | undefined }
	| { ok: false; topic: string };

/** `family` or `family:key`, checked against the registry. */
export function parseTopic(raw: string): Parsed {
	const [family, key, ...rest] = raw.split(":");
	if (rest.length || !family || !Object.hasOwn(topics, family))
		return { ok: false, topic: raw };
	const keyed = (keyedFamilies as readonly string[]).includes(family);
	if (!keyed) {
		return key === undefined
			? { ok: true, topic: family as Topic, family: family as Family, key }
			: { ok: false, topic: raw };
	}
	if (key === undefined || !/^[1-9]\d{0,15}$/.test(key))
		return { ok: false, topic: raw };
	const id = Number(key);
	return {
		ok: true,
		topic: topicOf(family as Family, id),
		family: family as Family,
		key: id,
	};
}

/** Writes one envelope; the multiplexed stream and the per-resource aliases differ only here. */
export type WriteEnvelope = (
	stream: SSEStreamingApi,
	envelope: Envelope,
) => Promise<void>;

/** `GET /api/events`: unnamed events whose data is the JSON envelope. */
export const writeEnvelope: WriteEnvelope = (stream, envelope) =>
	stream.writeSSE({ data: JSON.stringify(envelope) });

/**
 * Streams the topics as server-sent events: for each, its current state first, then every event
 * until it is terminal. Ends once no topic is left, or when the client goes away.
 */
export function streamTopics(
	c: Context<AppEnv>,
	requested: string[],
	write: WriteEnvelope = writeEnvelope,
) {
	const hub = c.var.svc.events;
	return streamSSE(c, async (stream) => {
		let chain: Promise<unknown> = Promise.resolve();
		const send = (envelope: Envelope) => {
			chain = chain.then(() => write(stream, envelope)).catch(() => {});
		};
		let finish: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		/** Topic -> what to undo when it is dropped. */
		const active = new Map<string, () => void>();
		let subscribed = false;
		const drop = (topic: string) => {
			active.get(topic)?.();
			active.delete(topic);
			if (subscribed && active.size === 0) chain.then(finish);
		};
		stream.onAbort(() => {
			for (const topic of [...active.keys()]) drop(topic);
			finish();
		});

		for (const raw of [...new Set(requested)].slice(0, MAX_TOPICS)) {
			const parsed = parseTopic(raw);
			if (!parsed.ok) {
				send({ topic: parsed.topic, error: "unknown topic" });
				continue;
			}
			const { topic, family, key } = parsed;
			if (active.has(topic)) continue;
			const def = topics[family] as TopicDef<Family>;
			if (def.authorize && !def.authorize(c, key)) {
				send({ topic, error: "forbidden" });
				continue;
			}
			let last = "";
			let done = false;
			const deliver = (
				data: Events[Family],
				seq: string,
				snapshot: boolean,
			) => {
				if (done) return;
				last = JSON.stringify(data);
				const final = def.terminal?.(data) ?? false;
				send({ topic, seq, snapshot, data, ...(final && { final }) });
				if (final) {
					done = true;
					drop(topic);
				}
			};
			// Subscribing and taking the snapshot happen in one synchronous step, so no event
			// can fall between them.
			const undo = [
				hub.subscribe(topic, (data, seq) =>
					deliver(data as Events[Family], seq, false),
				),
				...(def.refreshOn ?? []).map((other) =>
					hub.subscribe(other, () => {
						const next = def.snapshot(c, key);
						if (next !== null && JSON.stringify(next) !== last)
							deliver(next, hub.seq(topic), true);
					}),
				),
			];
			const snapshot = def.snapshot(c, key);
			if (snapshot === null) {
				for (const fn of undo) fn();
				send({ topic, error: "not found" });
				continue;
			}
			active.set(topic, () => {
				for (const fn of undo) fn();
			});
			deliver(snapshot, hub.seq(topic), true);
		}
		subscribed = true;
		if (active.size === 0) {
			await chain;
			return;
		}

		const ping = setInterval(() => {
			chain = chain.then(() => stream.write(": ping\n\n")).catch(() => {});
		}, PING_MS);
		await finished;
		clearInterval(ping);
		for (const topic of [...active.keys()]) drop(topic);
	});
}

const topicList = Object.entries(topics)
	.map(
		([family, def]) =>
			`\`${family}${def.key ? ":<id>" : ""}\` (${def.title.toLowerCase()}${def.key ? `; the key is the ${def.key.toLowerCase()}` : ""})`,
	)
	.join(", ");

export const eventRoutes = new Hono<AppEnv>().get(
	"/",
	doc({
		tag: "Events",
		summary: "Follow live updates",
		description: `Server-sent events for any number of topics: ${topicList}. Every event is unnamed and its data a JSON envelope \`{topic, seq, snapshot, data}\`; for each topic the first one is its current state (\`snapshot: true\`). A topic you may not follow, or that does not exist, gets one \`{topic, error}\` instead. \`seq\` counts the topic's events: a snapshot after reconnecting with the same \`seq\` as the last event you saw means you missed nothing. The stream ends once every topic is done (a revision ends after \`done\`, \`failed\` or \`gone\`); a \`: ping\` comment is sent every 20 seconds. The payloads are described in \`/api/asyncapi.json\`.`,
		query: {
			topics: `Comma separated, at most ${MAX_TOPICS}, e.g. \`map,revision:12,layers:1\``,
		},
		ok: { 200: "text/event-stream" },
	}),
	(c) =>
		streamTopics(c, (c.req.query("topics") ?? "").split(",").filter(Boolean)),
);

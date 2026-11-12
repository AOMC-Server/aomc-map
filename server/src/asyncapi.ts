import { z } from "zod";
import type { Env } from "./env";
import type { Family } from "./events";
import { type TopicDef, topics } from "./topics";

const jsonSchema = (schema: z.ZodType) => {
	const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: "draft-7" });
	return rest;
};

const envelope = (data: z.ZodType) =>
	z.object({
		topic: z.string(),
		seq: z.string(),
		snapshot: z.boolean(),
		final: z.literal(true).optional(),
		data,
	});

const errorMessage = {
	name: "error",
	title: "error event",
	summary:
		"Sent once, instead of anything else, for a topic you may not follow, that does not exist, or is not known.",
	contentType: "application/json",
	payload: jsonSchema(
		z.object({
			topic: z.string(),
			error: z.enum(["not found", "forbidden", "unknown topic"]),
		}),
	),
};

/**
 * AsyncAPI 3 description of the server-sent events the API pushes, generated from the topic
 * registry so it cannot drift from what is sent.
 */
export function asyncApiDocument(env: Env) {
	const url = new URL(env.PUBLIC_URL);
	const channels: Record<string, unknown> = {};
	const operations: Record<string, unknown> = {};
	for (const [family, def] of Object.entries(topics) as unknown as [
		string,
		TopicDef<Family>,
	][]) {
		const messages = Object.fromEntries(
			Object.entries(def.messages).map(([name, m]) => [
				name,
				{
					name,
					title: `${name} event`,
					summary: m.summary,
					contentType: "application/json",
					payload: jsonSchema(envelope(m.schema)),
				},
			]),
		);
		channels[family] = {
			address: `/api/events?topics=${family}${def.key ? ":{key}" : ""}`,
			title: def.title,
			description: `${def.description}${def.authorize ? "" : " Anyone may follow it."}`,
			servers: [{ $ref: "#/servers/default" }],
			...(def.key ? { parameters: { key: { description: def.key } } } : {}),
			messages: { ...messages, error: errorMessage },
		};
		operations[`receive_${family}`] = {
			action: "send",
			title: `Follow ${def.title.toLowerCase()}`,
			channel: { $ref: `#/channels/${family}` },
			messages: [...Object.keys(messages), "error"].map((name) => ({
				$ref: `#/channels/${family}/messages/${name}`,
			})),
		};
	}
	return {
		asyncapi: "3.0.0",
		info: {
			title: "AOMC Map events",
			version: "2.0.0",
			description: [
				"Server-sent events (`text/event-stream`) the API pushes, all from one stream: `GET /api/events?topics=a,b,…` follows any number of topics at once. Each topic is a channel below.",
				"Events are unnamed; the data of each is a JSON envelope `{topic, seq, snapshot, data}`. For every topic the first event is its current state (`snapshot: true`), and the last one of a topic that ends (a revision) has `final: true`; `seq` counts the topic's events, so a snapshot after a reconnect with the `seq` you saw last means you missed nothing. Collection topics (`revisions`, `layers`) carry no data: they say to fetch again.",
				"A `: ping` comment is sent every 20 seconds. The stream ends once every topic in it is done.",
				"`GET /api/revisions/{id}/events` is the `revision:{id}` topic on its own, with events named after the status and the bare data (no envelope); it answers 404 for an unknown revision.",
				"The HTTP request/response API is described in `/api/openapi.json`.",
			].join("\n\n"),
		},
		servers: {
			default: {
				host: url.host,
				protocol: url.protocol.replace(":", ""),
				description: "The map server (`PUBLIC_URL`).",
			},
		},
		channels,
		operations,
	};
}

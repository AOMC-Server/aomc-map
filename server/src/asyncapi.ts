import { z } from "zod";
import type { Env } from "./env";
import type { ProgressEvent } from "./progress";

// Typed against ProgressEvent so the document cannot drift from what the jobs emit.
const rev = z.number().int().nullable().optional();
const error = z.string().nullable().optional();

const payloads = {
	pending: z.object({ status: z.literal("pending"), rev, error }),
	processing: z.object({
		status: z.literal("processing"),
		message: z.string().optional(),
		done: z.number().int().optional(),
		total: z.number().int().optional(),
		rev,
		error,
	}),
	done: z.object({ status: z.literal("done"), rev, error }),
	failed: z.object({ status: z.literal("failed"), rev, error }),
} satisfies Record<string, z.ZodType<ProgressEvent>>;

const jsonSchema = (schema: z.ZodType) => {
	const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: "draft-7" });
	return rest;
};

const message = (name: string, summary: string, schema: z.ZodType) => ({
	name,
	title: `${name} event`,
	summary,
	contentType: "application/json",
	payload: jsonSchema(schema),
});

/** AsyncAPI 3 description of the server-sent events the API pushes. */
export function asyncApiDocument(env: Env) {
	const url = new URL(env.PUBLIC_URL);
	return {
		asyncapi: "3.0.0",
		info: {
			title: "AOMC Map events",
			version: "1.0.0",
			description:
				"Server-sent events (`text/event-stream`) the API pushes. The HTTP request/response API is described in `/api/openapi.json`.",
		},
		servers: {
			default: {
				host: url.host,
				protocol: url.protocol.replace(":", ""),
				description: "The map server (`PUBLIC_URL`).",
			},
		},
		channels: {
			revisionEvents: {
				address: "/api/revisions/{id}/events",
				title: "Revision progress",
				description:
					"Progress of an upload or of its deletion. The first event is the revision's current status; after that an event is sent for each step. The stream ends after `done` or `failed`. A `: ping` comment is sent every 20 seconds to keep the connection open. Answers 404 when the revision does not exist.",
				servers: [{ $ref: "#/servers/default" }],
				parameters: { id: { description: "Revision id" } },
				messages: {
					pending: message(
						"pending",
						"The revision is queued.",
						payloads.pending,
					),
					processing: message(
						"processing",
						"The job is running; `message`, `done` and `total` tell how far.",
						payloads.processing,
					),
					done: message(
						"done",
						"The job finished; `rev` is the revision number.",
						payloads.done,
					),
					failed: message(
						"failed",
						"The job failed; `error` says why.",
						payloads.failed,
					),
				},
			},
		},
		operations: {
			receiveRevisionEvents: {
				action: "send",
				title: "Follow a revision",
				summary: "The server sends progress events for one revision.",
				channel: { $ref: "#/channels/revisionEvents" },
				messages: [
					{ $ref: "#/channels/revisionEvents/messages/pending" },
					{ $ref: "#/channels/revisionEvents/messages/processing" },
					{ $ref: "#/channels/revisionEvents/messages/done" },
					{ $ref: "#/channels/revisionEvents/messages/failed" },
				],
			},
		},
	};
}

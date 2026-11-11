import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTempDirs, makeTestApp } from "./helpers";

afterAll(cleanupTempDirs);

type Spec = {
	openapi: string;
	paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
};

describe("OpenAPI spec", () => {
	test("is public and documents every API route", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/api/openapi.json");
		expect(res.status).toBe(200);
		const spec = (await res.json()) as Spec;
		expect(spec.openapi).toStartWith("3.");

		const documented = new Set<string>();
		for (const [path, methods] of Object.entries(spec.paths)) {
			for (const [method, op] of Object.entries(methods)) {
				documented.add(`${method.toUpperCase()} ${path}`);
				expect(op.summary, `${method} ${path} has no summary`).toBeTruthy();
				expect(op.tags?.length, `${method} ${path} has no tag`).toBe(1);
			}
		}

		const missing = app.routes
			.filter(
				(r) =>
					r.method !== "ALL" &&
					r.path !== "/api/openapi.json" &&
					r.path !== "/api/asyncapi.json" &&
					/^\/(api|auth|blobs)\//.test(r.path),
			)
			.map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`)
			.filter((key) => !documented.has(key));
		expect(missing).toEqual([]);
	});

	test("serves the Scalar reference with both documents, without a CDN", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/scalar");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("/api/openapi.json");
		expect(html).toContain("/api/asyncapi.json");
		expect(html).not.toContain("jsdelivr");

		const bundle = await app.request("/scalar/standalone.js");
		expect(bundle.status).toBe(200);
		expect(bundle.headers.get("content-type")).toContain("javascript");
	});

	test("describes the progress events as AsyncAPI 3", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/api/asyncapi.json");
		expect(res.status).toBe(200);
		const doc = (await res.json()) as {
			asyncapi: string;
			channels: Record<string, { address: string; messages: object }>;
		};
		expect(doc.asyncapi).toStartWith("3.");
		expect(doc.channels.revisionEvents?.address).toBe(
			"/api/revisions/{id}/events",
		);
		expect(Object.keys(doc.channels.revisionEvents?.messages ?? {})).toEqual([
			"pending",
			"processing",
			"done",
			"failed",
		]);
	});

	test("describes request bodies from the zod schemas", async () => {
		const { app } = makeTestApp();
		const spec = (await (
			await app.request("/api/openapi.json")
		).json()) as Spec;
		const create = spec.paths["/api/layers"]?.post as unknown as {
			requestBody: { content: Record<string, unknown> };
		};
		expect(Object.keys(create.requestBody.content)).toContain(
			"application/json",
		);
	});

	test("documents the validation error and the extra statuses", async () => {
		const { app } = makeTestApp();
		const spec = (await (await app.request("/api/openapi.json")).json()) as {
			paths: Record<
				string,
				Record<
					string,
					{
						responses: Record<
							string,
							{
								content?: {
									"application/json": {
										schema: {
											properties: Record<string, unknown>;
											required: string[];
										};
									};
								};
							}
						>;
					}
				>
			>;
		};
		const bad =
			spec.paths["/api/layers"]?.post?.responses["400"]?.content?.[
				"application/json"
			].schema;
		expect(bad?.required).toEqual(["error"]);
		expect(Object.keys(bad?.properties ?? {})).toEqual(["error", "issues"]);
		const preview = spec.paths["/api/preview.png"]?.get?.responses;
		expect(Object.keys(preview ?? {})).toEqual(
			expect.arrayContaining(["429", "503"]),
		);
		const patch = spec.paths["/api/features/{id}"]?.patch?.responses;
		expect(Object.keys(patch ?? {})).toContain("409");
	});
});

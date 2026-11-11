import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import type { AppEnv } from "./types";

// Scalar's own browser bundle, served from node_modules so the page needs no CDN.
const bundle = Bun.file(
	new URL(
		"./browser/standalone.js",
		import.meta.resolve("@scalar/api-reference"),
	),
);

/** The API reference at /scalar: the HTTP API (OpenAPI) and the events (AsyncAPI). */
export const docsRoutes = new Hono<AppEnv>()
	.get(
		"/",
		Scalar({
			pageTitle: "AOMC Map API",
			sources: [
				{ title: "HTTP API", url: "/api/openapi.json" },
				{ title: "Events", url: "/api/asyncapi.json" },
			],
			cdn: "/scalar/standalone.js",
			withDefaultFonts: false,
			telemetry: false,
		}),
	)
	.get(
		"/standalone.js",
		() =>
			new Response(bundle, {
				headers: {
					"Content-Type": "text/javascript; charset=utf-8",
					"Cache-Control": "public, max-age=86400",
				},
			}),
	);

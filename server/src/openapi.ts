import { describeRoute } from "hono-openapi";

export const apiDescription = [
	"Authentication is a session cookie (browser) or `Authorization: Bearer aomc_…` (scripts).",
	"Tokens are created on the Settings page or with `POST /api/tokens` (session only).",
	"A token has scopes (`read`, `upload`, `features`, `moderate`, `manage`) and never more access than its user: without `read`, GETs are answered as to an anonymous visitor; a write outside its scopes answers 403.",
	"Writes made with a cookie must come from `PUBLIC_URL` (CSRF check); Bearer requests need no such check.",
	'Errors are JSON `{"error": "…"}`. Resources you may not see answer 404.',
].join(" ");

export const securitySchemes = {
	bearer: {
		type: "http",
		scheme: "bearer",
		description: "API token (`aomc_…`) from the Settings page.",
	},
	session: {
		type: "apiKey",
		in: "cookie",
		name: "session",
		description: "Browser session from the Discord login.",
	},
} as const;

export const tags = [
	{ name: "Session", description: "Login, current user and API tokens" },
	{ name: "Map", description: "Map settings, dimensions and members" },
	{ name: "Tiles", description: "Map images" },
	{ name: "Uploads", description: "Uploading Xaero exports" },
	{ name: "Revisions", description: "Upload history and progress" },
	{ name: "Layers", description: "Layers of pins, lines and areas" },
	{ name: "Features", description: "Individual pins, lines and areas" },
	{ name: "Sharing", description: "Invites and layer members" },
	{ name: "Images", description: "Blobs and link previews" },
	{ name: "Stats", description: "Contribution statistics and leaderboard" },
	{ name: "Admin", description: "Storage, traffic and server statistics" },
];

const requiresLogin: Record<string, string[]>[] = [
	{ bearer: [] },
	{ session: [] },
];

const errorResponse = (description: string) => ({
	description,
	content: {
		"application/json": {
			schema: {
				type: "object" as const,
				properties: { error: { type: "string" as const } },
				required: ["error"],
			},
		},
	},
});

/** Status codes that need no per-route text. */
export const errors = {
	400: errorResponse("Invalid request"),
	401: errorResponse("Not logged in"),
	403: errorResponse("Not allowed"),
	404: errorResponse("Not found, or not visible to you"),
	409: errorResponse("Conflict"),
	410: errorResponse("Gone: expired, revoked or used up"),
	413: errorResponse("Upload too large"),
	429: errorResponse("Rate limited"),
	502: errorResponse("Discord could not be reached"),
} as const;

type Doc = {
	tag: string;
	summary: string;
	description?: string;
	/** Success responses; the handlers return plain JSON, so these only carry a description. */
	ok?: Record<number, string>;
	/** Error status codes this route can answer, from `errors`. */
	fails?: (keyof typeof errors)[];
	/** The route needs a login (a session or a token). */
	login?: boolean;
	/** Query parameters the handler reads itself, without a zod validator. */
	query?: Record<string, string>;
	/** For bodies a zod validator can't describe, such as multipart uploads. */
	requestBody?: Record<string, unknown>;
};

/** describeRoute with the conventions of this API filled in. */
export function doc(d: Doc) {
	const responses: Record<number, unknown> = {};
	for (const [status, description] of Object.entries(d.ok ?? { 200: "OK" })) {
		responses[Number(status)] = { description };
	}
	for (const status of d.fails ?? []) responses[status] = errors[status];
	if (d.login) responses[401] = errors[401];
	return describeRoute({
		tags: [d.tag],
		summary: d.summary,
		description: d.description,
		security: d.login ? requiresLogin : undefined,
		parameters: Object.entries(d.query ?? {}).map(([name, description]) => ({
			name,
			in: "query" as const,
			description,
			schema: { type: "string" as const },
		})),
		requestBody: d.requestBody as never,
		responses: responses as never,
	});
}

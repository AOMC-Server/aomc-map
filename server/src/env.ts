import { z } from "zod";

const DEV_SESSION_SECRET = "dev-only-secret-change-me";

const envSchema = z.object({
	NODE_ENV: z.string().optional(),
	PORT: z.coerce.number().int().default(3000),
	DATA_DIR: z.string().default("./data"),
	PUBLIC_URL: z.string().url().default("http://localhost:3000"),
	DISCORD_CLIENT_ID: z.string().default(""),
	DISCORD_CLIENT_SECRET: z.string().default(""),
	SESSION_SECRET: z.string().min(16).default(DEV_SESSION_SECRET),
	PREVIEW_CACHE_MAX: z.coerce.number().int().min(1).default(500), // cached link-preview images
	WEB_DIST: z.string().optional(), // defaults to <repo>/web/dist
	DEFAULT_TILE_SIZE: z.coerce
		.number()
		.int()
		.positive()
		.refine((n) => n % 2 === 0, "must be even")
		.default(512),
	MAX_ZOOM: z.coerce.number().int().min(0).max(12).default(8),
	MAX_UPLOAD_BYTES: z.coerce
		.number()
		.int()
		.default(200 * 1024 * 1024),
	MAX_IMAGE_DIM: z.coerce.number().int().default(4096),
	MAX_FILES_PER_UPLOAD: z.coerce.number().int().default(2000),
	UPLOAD_RATE_LIMIT: z.coerce.number().int().default(30), // requests per user per minute
	// How long after uploading someone may delete their own upload; 0 = only moderators delete
	SELF_DELETE_WINDOW_HOURS: z.coerce.number().min(0).default(24),
	SETUP_MAP_NAME: z.string().default("AOMC"),
	SETUP_OWNER_DISCORD_IDS: z
		.string()
		.default("")
		.transform((s) =>
			s
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean),
		),
	// Who is responsible for the personal data (the GDPR "controller") and how to reach them;
	// shown on the /privacy page.
	PRIVACY_CONTROLLER: z.string().trim().default(""),
	PRIVACY_CONTACT: z.string().trim().default(""),
	// User-Agents (comma separated, `*` is a wildcard) that mark an upload as sent by the in-game mod
	MOD_USER_AGENTS: z
		.string()
		.default("AOMC Webmapper,AOMC Visited")
		.transform((s) =>
			s
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean),
		),
});

export type Env = z.infer<typeof envSchema> & {
	/** Cookies get the Secure flag when the site is served over https. */
	COOKIE_SECURE: boolean;
};

export function parseEnv(
	source: Record<string, string | undefined> = process.env,
): Env {
	const env = envSchema.parse(source);
	const https = env.PUBLIC_URL.startsWith("https:");
	if (
		(https || env.NODE_ENV === "production") &&
		env.SESSION_SECRET === DEV_SESSION_SECRET
	) {
		throw new Error(
			"SESSION_SECRET must be set when PUBLIC_URL is https or NODE_ENV is production",
		);
	}
	return { ...env, COOKIE_SECURE: https };
}

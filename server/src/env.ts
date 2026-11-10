import { z } from "zod";

const envSchema = z.object({
	PORT: z.coerce.number().int().default(3000),
	DATA_DIR: z.string().default("./data"),
	PUBLIC_URL: z.string().url().default("http://localhost:3000"),
	DISCORD_CLIENT_ID: z.string().default(""),
	DISCORD_CLIENT_SECRET: z.string().default(""),
	SESSION_SECRET: z.string().min(16).default("dev-only-secret-change-me"),
	WEB_DIST: z.string().optional(), // defaults to <repo>/web/dist
	DEFAULT_TILE_SIZE: z.coerce.number().int().default(512),
	MAX_ZOOM: z.coerce.number().int().min(1).max(12).default(8),
	MAX_UPLOAD_BYTES: z.coerce
		.number()
		.int()
		.default(200 * 1024 * 1024),
	MAX_IMAGE_DIM: z.coerce.number().int().default(4096),
	MAX_FILES_PER_UPLOAD: z.coerce.number().int().default(2000),
	UPLOAD_RATE_LIMIT: z.coerce.number().int().default(30), // requests per user per minute
	SETUP_MAP_NAME: z.string().default("AOMC"),
	SETUP_MAP_SLUG: z.string().default("aomc"),
	SETUP_OWNER_DISCORD_IDS: z
		.string()
		.default("")
		.transform((s) =>
			s
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean),
		),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(
	source: Record<string, string | undefined> = process.env,
): Env {
	return envSchema.parse(source);
}

import { z } from "zod";

const envSchema = z.object({
	PORT: z.coerce.number().int().default(3000),
	DATA_DIR: z.string().default("./data"),
	PUBLIC_URL: z.string().url().default("http://localhost:3000"),
	DISCORD_CLIENT_ID: z.string().default(""),
	DISCORD_CLIENT_SECRET: z.string().default(""),
	SESSION_SECRET: z.string().min(16).default("dev-only-secret-change-me"),
	DEFAULT_TILE_SIZE: z.coerce.number().int().default(512),
	MAX_ZOOM: z.coerce.number().int().default(8),
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

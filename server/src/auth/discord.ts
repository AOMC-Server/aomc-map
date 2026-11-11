import type { Db } from "../db/client";
import { users } from "../db/schema";
import type { Env } from "../env";
import { applyPendingOwners } from "../setup";

const API = "https://discord.com/api/v10";

export type DiscordProfile = {
	id: string;
	username: string;
	avatar: string | null;
};

export function authorizeUrl(env: Env, state: string): string {
	const params = new URLSearchParams({
		client_id: env.DISCORD_CLIENT_ID,
		redirect_uri: redirectUri(env),
		response_type: "code",
		scope: "identify",
		state,
	});
	return `https://discord.com/oauth2/authorize?${params}`;
}

function redirectUri(env: Env): string {
	return new URL("/auth/discord/callback", env.PUBLIC_URL).toString();
}

export async function fetchProfile(
	env: Env,
	code: string,
	fetchFn: typeof fetch = fetch,
): Promise<DiscordProfile> {
	const tokenRes = await fetchFn(`${API}/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.DISCORD_CLIENT_ID,
			client_secret: env.DISCORD_CLIENT_SECRET,
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri(env),
		}),
	});
	if (!tokenRes.ok)
		throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
	const { access_token } = (await tokenRes.json()) as { access_token: string };

	const meRes = await fetchFn(`${API}/users/@me`, {
		headers: { Authorization: `Bearer ${access_token}` },
	});
	if (!meRes.ok)
		throw new Error(`Discord profile fetch failed: ${meRes.status}`);
	const me = (await meRes.json()) as {
		id: string;
		username: string;
		global_name?: string | null;
		avatar: string | null;
	};
	return {
		id: me.id,
		username: me.global_name || me.username,
		avatar: me.avatar,
	};
}

function avatarUrl(profile: DiscordProfile): string | null {
	return profile.avatar
		? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
		: null;
}

export function upsertUser(db: Db, profile: DiscordProfile) {
	const now = Date.now();
	const values = {
		username: profile.username,
		avatarUrl: avatarUrl(profile),
		lastLoginAt: now,
	};
	db.insert(users)
		.values({ id: profile.id, createdAt: now, ...values })
		.onConflictDoUpdate({ target: users.id, set: values })
		.run();
	applyPendingOwners(db, profile.id);
}

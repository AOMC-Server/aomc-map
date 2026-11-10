import { hc } from "hono/client";
import type { AppType } from "../../server/src/app";

/** Typed client; request and response types come from the server's route definitions. */
export const api = hc<AppType>("/");

export function loginUrl(): string {
	const returnTo = location.pathname + location.search;
	return `/auth/discord?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function logout(): Promise<void> {
	await fetch("/auth/logout", { method: "POST" });
}

import { hc } from "hono/client";
import type { AppType } from "../../server/src/app";
import { type ErrorBody, failureMessage } from "./errors";
import { currentMap, notice } from "./state";

/** Typed client; request and response types come from the server's route definitions. */
export const api = hc<AppType>("/");

export function loginUrl(
	returnTo = location.pathname + location.search,
): string {
	return `/auth/discord?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function logout(): Promise<void> {
	await fetch("/auth/logout", { method: "POST" });
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export function showNotice(text: string, kind: "error" | "info" = "info") {
	notice.value = { text, kind };
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		notice.value = null;
	}, 5000);
}

export type Res = { ok: boolean; status: number; json(): Promise<unknown> };

/** Body of a successful response: the route's result without its `{ error }` variants. */
export type Success<R extends Res> = Exclude<
	Awaited<ReturnType<R["json"]>>,
	{ error: string }
>;

/** A write was refused for maintenance: show the banner now rather than at the next refresh. */
function noticeMaintenance() {
	const detail = currentMap.value;
	if (detail && !detail.map.maintenance)
		currentMap.value = {
			...detail,
			map: { ...detail.map, maintenance: true },
		};
}

type Result<T> =
	| { ok: true; body: T }
	| { ok: false; error: string; status: number; detail: ErrorBody | null };

/** Runs an API call and turns every kind of failure into an error message. */
export async function attempt<R extends Res>(
	call: () => Promise<R>,
): Promise<Result<Success<R>>> {
	try {
		const res = await call();
		if (res.ok) return { ok: true, body: (await res.json()) as Success<R> };
		const detail = (await res.json().catch(() => null)) as ErrorBody | null;
		if (res.status === 503 && detail?.reason === "maintenance")
			noticeMaintenance();
		return {
			ok: false,
			error: failureMessage(res.status, detail),
			status: res.status,
			detail,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Network error",
			status: 0,
			detail: null,
		};
	}
}

/**
 * Runs an API call, reporting failures to the user. Returns the parsed body, or null on failure.
 * `after` runs once the call succeeded (e.g. to reload what it changed); if it throws, the user
 * is told, but the call still counts as having worked.
 */
export async function run<R extends Res>(
	call: () => Promise<R>,
	after?: () => Promise<void>,
): Promise<Success<R> | null> {
	const result = await attempt(call);
	if (!result.ok) {
		showNotice(result.error, "error");
		return null;
	}
	try {
		await after?.();
	} catch (err) {
		showNotice(
			err instanceof Error
				? err.message
				: "Could not refresh after the change.",
			"error",
		);
	}
	return result.body;
}

/** Like `run`, for callers that only care whether it worked. */
export async function ok(
	call: () => Promise<Res>,
	after?: () => Promise<void>,
): Promise<boolean> {
	return (await run(call, after)) !== null;
}

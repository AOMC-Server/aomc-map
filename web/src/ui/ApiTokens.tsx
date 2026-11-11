import {
	DEFAULT_TOKEN_EXPIRY_DAYS,
	DEFAULT_TOKEN_SCOPES,
	MAX_TOKENS_PER_USER,
	normalizeScopes,
	TOKEN_SCOPES,
	type TokenScope,
} from "@aomc/shared";
import { MAX_NAME } from "@aomc/shared/features";
import type { InferResponseType } from "hono/client";
import { useEffect, useState } from "preact/hooks";
import { api, ok, run } from "../api";
import { formatTime } from "./format";
import { type ExpiryOption, ExpirySelect, ShownOnce } from "./shareCommon";

type TokenInfo = InferResponseType<
	typeof api.api.tokens.$get,
	200
>["tokens"][number];

const EXPIRIES: ExpiryOption[] = [
	{ label: "30 days", value: 30 },
	{ label: "90 days", value: 90 },
	{
		label: `${DEFAULT_TOKEN_EXPIRY_DAYS} days`,
		value: DEFAULT_TOKEN_EXPIRY_DAYS,
	},
	{ label: "1 year", value: 365 },
	{ label: "Never", value: null },
];

const SCOPE_INFO: Record<TokenScope, { label: string; hint: string }> = {
	read: {
		label: "Read",
		hint: "See what you can see, such as private layers. Without it, reads are anonymous.",
	},
	upload: {
		label: "Upload",
		hint: "Upload Xaero exports and delete your own uploads.",
	},
	features: {
		label: "Layers and features",
		hint: "Create and edit layers, pins, lines and areas, and share layers.",
	},
	moderate: {
		label: "Moderate",
		hint: "Use moderator powers: delete any upload, restore features, edit dimensions.",
	},
	manage: {
		label: "Manage",
		hint: "Use owner powers: members, map invites and map settings. Includes Moderate.",
	},
};

function expiryText(t: TokenInfo, now: number): string {
	if (t.expiresAt === null) return "never expires";
	return t.expiresAt <= now
		? `expired ${formatTime(t.expiresAt)}`
		: `expires ${formatTime(t.expiresAt)}`;
}

/** Create, copy and revoke the API tokens that let scripts act as you. */
export function ApiTokens() {
	const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
	const [name, setName] = useState("");
	const [days, setDays] = useState<number | null>(DEFAULT_TOKEN_EXPIRY_DAYS);
	const [scopes, setScopes] = useState<TokenScope[]>(DEFAULT_TOKEN_SCOPES);
	const [busy, setBusy] = useState(false);
	// Shown once, right after creation; kept only in this component's state.
	const [created, setCreated] = useState<{
		id: number;
		name: string;
		token: string;
	} | null>(null);

	const reload = async () => {
		const body = await run(() => api.api.tokens.$get());
		if (body) setTokens(body.tokens);
	};
	useEffect(() => {
		void reload();
	}, []);

	const createToken = (trimmed: string) =>
		run(() =>
			api.api.tokens.$post({
				json: { name: trimmed, expiresInDays: days, scopes },
			}),
		);

	const create = async (e: Event) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		setBusy(true);
		let body: Awaited<ReturnType<typeof createToken>> = null;
		try {
			body = await createToken(trimmed);
		} finally {
			setBusy(false);
		}
		if (body) {
			setCreated({ id: body.id, name: body.name, token: body.token });
			setName("");
			await reload();
		}
	};

	const revoke = async (t: TokenInfo) => {
		if (!confirm(`Revoke "${t.name}"? Scripts using it will stop working.`))
			return;
		setBusy(true);
		let done = false;
		try {
			done = await ok(() =>
				api.api.tokens[":id"].$delete({ param: { id: String(t.id) } }),
			);
		} finally {
			setBusy(false);
		}
		if (done) {
			if (created?.id === t.id) setCreated(null);
			await reload();
		}
	};

	const toggleScope = (scope: TokenScope, on: boolean) => {
		const next = on ? [...scopes, scope] : scopes.filter((s) => s !== scope);
		// Unticking Moderate also unticks Manage, which implies it.
		setScopes(
			normalizeScopes(
				!on && scope === "moderate" ? next.filter((s) => s !== "manage") : next,
			),
		);
	};

	const now = Date.now();
	const full = (tokens?.length ?? 0) >= MAX_TOKENS_PER_USER;

	return (
		<section class="page-section">
			<h2>API tokens</h2>
			<p class="muted">
				Tokens let scripts act as you. Send one as{" "}
				<code>Authorization: Bearer &lt;token&gt;</code>. A token can do what
				its scopes allow, and never more than your account can, so give it only
				the scopes it needs and keep it secret. See the{" "}
				<a href="/scalar" target="_blank" rel="noopener">
					API documentation
				</a>{" "}
				for the endpoints.
			</p>

			{created && (
				<ShownOnce
					intro={
						<>
							<b>{created.name}</b> was created. Copy it now: it won't be shown
							again.
						</>
					}
					value={created.token}
					label="New API token"
					copied="Token copied"
					onDone={() => setCreated(null)}
				/>
			)}

			<form class="invite-form" onSubmit={create}>
				<label>
					<span class="label">Name</span>
					<input
						type="text"
						placeholder="e.g. upload script"
						maxLength={MAX_NAME}
						value={name}
						onInput={(e) => setName(e.currentTarget.value)}
					/>
				</label>
				<ExpirySelect options={EXPIRIES} value={days} onChange={setDays} />
				<fieldset class="token-scopes">
					<legend class="label">Scopes</legend>
					{TOKEN_SCOPES.map((s) => (
						<label key={s} title={SCOPE_INFO[s].hint}>
							<input
								type="checkbox"
								checked={scopes.includes(s)}
								onChange={(e) => toggleScope(s, e.currentTarget.checked)}
							/>
							<span>
								{SCOPE_INFO[s].label}
								<span class="muted hint"> — {SCOPE_INFO[s].hint}</span>
							</span>
						</label>
					))}
				</fieldset>
				<button
					type="submit"
					class="btn primary"
					disabled={busy || full || !name.trim() || scopes.length === 0}
				>
					Generate token
				</button>
			</form>
			{full && (
				<p class="hint">
					You have {MAX_TOKENS_PER_USER} tokens, the maximum. Revoke one to make
					a new one.
				</p>
			)}

			{tokens === null ? (
				<p class="muted">Loading…</p>
			) : tokens.length === 0 ? (
				<p class="muted">You have no API tokens.</p>
			) : (
				<ul class="invite-list">
					{tokens.map((t) => (
						<li
							key={t.id}
							class={
								t.expiresAt !== null && t.expiresAt <= now ? "expired" : ""
							}
						>
							<div class="invite-main">
								<div>{t.name}</div>
								<div class="muted hint">
									created {formatTime(t.createdAt)} ·{" "}
									{t.lastUsedAt === null
										? "never used"
										: `last used ${formatTime(t.lastUsedAt)}`}{" "}
									· {expiryText(t, now)}
								</div>
								<div class="muted hint">
									{t.scopes.map((s) => SCOPE_INFO[s].label).join(", ")}
								</div>
							</div>
							<button
								type="button"
								class="btn small danger"
								disabled={busy}
								onClick={() => void revoke(t)}
							>
								Revoke
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

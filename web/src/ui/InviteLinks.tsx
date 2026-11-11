import { DEFAULT_INVITE_HOURS } from "@aomc/shared";
import { useEffect, useState } from "preact/hooks";
import { showNotice } from "../api";
import {
	type CreatedInvite,
	type InviteInfo,
	revokeInvite,
	type Scope,
} from "../sharing";
import { formatTime } from "./format";

const EXPIRIES: { label: string; hours: number | null }[] = [
	{ label: "1 day", hours: 24 },
	{ label: "7 days", hours: DEFAULT_INVITE_HOURS },
	{ label: "30 days", hours: 24 * 30 },
	{ label: "Never", hours: null },
];

function describeStatus(i: InviteInfo): string {
	if (i.status !== "active") return i.status;
	const uses =
		i.maxUses === null ? `${i.uses} used` : `${i.uses}/${i.maxUses} used`;
	const until =
		i.expiresAt === null
			? "never expires"
			: `expires ${formatTime(i.expiresAt)}`;
	return `${uses}, ${until}`;
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		showNotice("Link copied.");
	} catch {
		showNotice(
			"Could not copy; select the link and copy it manually.",
			"error",
		);
	}
}

/** Create, copy and revoke invite links for the map or one private layer. */
export function InviteLinks<R extends string>(props: { scope: Scope<R> }) {
	const { scope } = props;
	const [list, setList] = useState<InviteInfo[] | null>(null);
	const [role, setRole] = useState<R>(scope.defaultInviteRole);
	const [hours, setHours] = useState<number | null>(DEFAULT_INVITE_HOURS);
	const [maxUses, setMaxUses] = useState("");
	const [created, setCreated] = useState<CreatedInvite | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = async () => {
		const l = await scope.loadInvites();
		if (l) setList(l);
	};
	useEffect(() => {
		setCreated(null);
		setList(null);
		void reload();
	}, [scope.key]);

	const create = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		const out = await scope.createInvite(
			{
				expiresInHours: hours,
				maxUses:
					maxUses.trim() === ""
						? null
						: Math.max(1, Number.parseInt(maxUses, 10) || 1),
			},
			role,
		);
		setBusy(false);
		if (out) {
			setCreated(out);
			await reload();
		}
	};

	return (
		<section class="invites">
			<h3 class="section-title">Invite links</h3>
			{scope.inviteHelp && <p class="muted">{scope.inviteHelp}</p>}
			<form class="invite-form" onSubmit={create}>
				{scope.inviteRoles.length > 0 && (
					<label>
						<span class="label">Role</span>
						<select
							value={role}
							onChange={(e) =>
								setRole(
									scope.inviteRoles.find((r) => r === e.currentTarget.value) ??
										role,
								)
							}
						>
							{scope.inviteRoles.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</label>
				)}
				<label>
					<span class="label">Expires</span>
					<select
						value={hours === null ? "never" : String(hours)}
						onChange={(e) =>
							setHours(
								e.currentTarget.value === "never"
									? null
									: Number(e.currentTarget.value),
							)
						}
					>
						{EXPIRIES.map((x) => (
							<option
								key={x.label}
								value={x.hours === null ? "never" : String(x.hours)}
							>
								{x.label}
							</option>
						))}
					</select>
				</label>
				<label>
					<span class="label">Max uses</span>
					<input
						type="text"
						inputMode="numeric"
						placeholder="unlimited"
						value={maxUses}
						onInput={(e) =>
							setMaxUses(e.currentTarget.value.replace(/\D/g, ""))
						}
					/>
				</label>
				<button type="submit" class="btn primary" disabled={busy}>
					Create link
				</button>
			</form>

			{created && (
				<div class="new-link">
					<p class="muted">
						Copy it now: for safety the link is only shown once.
					</p>
					<div class="link-row">
						<input
							type="text"
							readOnly
							value={created.url}
							aria-label="Invite link"
							onFocus={(e) => e.currentTarget.select()}
						/>
						<button type="button" class="btn" onClick={() => copy(created.url)}>
							Copy
						</button>
					</div>
				</div>
			)}

			<ul class="invite-list">
				{list?.map((i) => (
					<li key={i.id} class={i.status}>
						<div class="invite-main">
							<b>{i.role}</b> <span class="muted">by {i.createdByName}</span>
							<div class="muted">{describeStatus(i)}</div>
						</div>
						{i.status === "active" && (
							<button
								type="button"
								class="btn small danger"
								onClick={async () => {
									if (await revokeInvite(i.id)) await reload();
								}}
							>
								Revoke
							</button>
						)}
					</li>
				))}
			</ul>
			{list?.length === 0 && <p class="muted">No invite links yet.</p>}
		</section>
	);
}

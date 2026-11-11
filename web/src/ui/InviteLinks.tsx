import { DEFAULT_INVITE_HOURS } from "@aomc/shared";
import { useEffect, useState } from "preact/hooks";
import {
	type CreatedInvite,
	type InviteInfo,
	revokeInvite,
	type Scope,
} from "../sharing";
import { formatTime } from "./format";
import { type ExpiryOption, ExpirySelect, ShownOnce } from "./shareCommon";

const EXPIRIES: ExpiryOption[] = [
	{ label: "1 day", value: 24 },
	{ label: "7 days", value: DEFAULT_INVITE_HOURS },
	{ label: "30 days", value: 24 * 30 },
	{ label: "Never", value: null },
];

/** The most uses the server accepts for one link. */
const MAX_USES = 1000;

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
		let out: CreatedInvite | null = null;
		try {
			out = await scope.createInvite(
				{
					expiresInHours: hours,
					maxUses:
						maxUses.trim() === ""
							? null
							: Math.min(
									MAX_USES,
									Math.max(1, Number.parseInt(maxUses, 10) || 1),
								),
				},
				role,
			);
		} finally {
			setBusy(false);
		}
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
				<ExpirySelect options={EXPIRIES} value={hours} onChange={setHours} />
				<label>
					<span class="label">Max uses</span>
					<input
						type="text"
						inputMode="numeric"
						placeholder="unlimited"
						maxLength={String(MAX_USES).length}
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
				<ShownOnce
					intro="Copy it now: for safety the link is only shown once."
					value={created.url}
					label="Invite link"
					copied="Link copied."
				/>
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

import { useEffect, useState } from "preact/hooks";
import { showNotice } from "../layers";
import {
	type CreatedInvite,
	createLayerInvite,
	createMapInvite,
	type InviteInfo,
	loadLayerInvites,
	loadMapInvites,
	revokeInvite,
} from "../sharing";
import { formatTime } from "./format";
import type { MembersScope } from "./MembersSection";

const MAP_ROLES = ["viewer", "editor", "moderator"] as const;
const LAYER_ROLES = ["viewer", "editor"] as const;

const EXPIRIES: { label: string; hours: number | null }[] = [
	{ label: "1 day", hours: 24 },
	{ label: "7 days", hours: 24 * 7 },
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
export function InviteLinks(props: { scope: MembersScope }) {
	const scope = props.scope;
	const isLayer = scope.kind === "layer";
	const layerId = scope.kind === "layer" ? scope.layerId : 0;
	const roles: readonly string[] = isLayer ? LAYER_ROLES : MAP_ROLES;

	const [list, setList] = useState<InviteInfo[] | null>(null);
	const [role, setRole] = useState("editor");
	const [hours, setHours] = useState<number | null>(24 * 7);
	const [maxUses, setMaxUses] = useState("");
	const [created, setCreated] = useState<CreatedInvite | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = async () => {
		const l = isLayer
			? await loadLayerInvites(layerId)
			: await loadMapInvites();
		if (l) setList(l);
	};
	useEffect(() => {
		setCreated(null);
		void reload();
	}, [layerId, isLayer]);

	const create = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		const input = {
			role,
			expiresInHours: hours,
			maxUses:
				maxUses.trim() === ""
					? null
					: Math.max(1, Number.parseInt(maxUses, 10) || 1),
		};
		const out = isLayer
			? await createLayerInvite(
					layerId,
					input as Parameters<typeof createLayerInvite>[1],
				)
			: await createMapInvite(input as Parameters<typeof createMapInvite>[0]);
		setBusy(false);
		if (out) {
			setCreated(out);
			await reload();
		}
	};

	return (
		<section class="invites">
			<h3 class="section-title">Invite links</h3>
			<form class="invite-form" onSubmit={create}>
				<label>
					<span class="label">Role</span>
					<select value={role} onChange={(e) => setRole(e.currentTarget.value)}>
						{roles.map((r) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
				</label>
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

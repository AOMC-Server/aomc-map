import type { Role } from "@aomc/shared/schemas";
import { useEffect, useState } from "preact/hooks";
import { showNotice } from "../layers";
import {
	addLayerMember,
	addMapMember,
	type LayerRoleName,
	loadLayerMembers,
	loadMapMembers,
	type Member,
	removeLayerMember,
	removeMapMember,
	setLayerMemberRole,
	setMapMemberRole,
} from "../sharing";
import { user } from "../state";

export type MembersScope = { kind: "map" } | { kind: "layer"; layerId: number };

const MAP_ROLES: Role[] = ["viewer", "editor", "moderator", "owner"];
const LAYER_ROLES: LayerRoleName[] = ["viewer", "editor"];

const ROLE_HELP: Record<string, string> = {
	viewer: "can look at the map",
	editor: "can upload and edit",
	moderator: "can also revert uploads and restore features",
	owner: "can also manage members, invites and settings",
};

const RANK = ["owner", "moderator", "editor", "viewer"];

/** Highest role first, then by name. */
const sortMembers = (list: Member<string>[]) =>
	[...list].sort(
		(a, b) =>
			RANK.indexOf(a.role) - RANK.indexOf(b.role) ||
			a.username.localeCompare(b.username),
	);

/** Members of the map or of one private layer: change roles, remove people, add by Discord id. */
export function MembersSection(props: { scope: MembersScope }) {
	const scope = props.scope;
	const isLayer = scope.kind === "layer";
	const roles: string[] = isLayer ? LAYER_ROLES : MAP_ROLES;
	const layerId = scope.kind === "layer" ? scope.layerId : 0;

	const [members, setMembers] = useState<Member<string>[] | null>(null);
	const [newId, setNewId] = useState("");
	const [newRole, setNewRole] = useState(isLayer ? "viewer" : "editor");
	const [busy, setBusy] = useState(false);

	const reload = async () => {
		const list = isLayer
			? await loadLayerMembers(layerId)
			: await loadMapMembers();
		if (list) setMembers(sortMembers(list as Member<string>[]));
	};
	useEffect(() => {
		void reload();
	}, [layerId, isLayer]);

	const act = async (fn: () => Promise<boolean>) => {
		setBusy(true);
		const ok = await fn();
		setBusy(false);
		if (ok) await reload();
		return ok;
	};

	const changeRole = (m: Member<string>, role: string) =>
		act(() =>
			isLayer
				? setLayerMemberRole(layerId, m.userId, role as LayerRoleName)
				: setMapMemberRole(m.userId, role as Role),
		);

	const remove = (m: Member<string>) => {
		const self = m.userId === user.value?.id;
		const ask = self ? "Leave? You may lose access." : `Remove ${m.username}?`;
		if (!confirm(ask)) return;
		return act(() =>
			isLayer
				? removeLayerMember(layerId, m.userId)
				: removeMapMember(m.userId),
		);
	};

	const add = async (e: Event) => {
		e.preventDefault();
		const id = newId.trim();
		if (!id) return;
		const ok = await act(() =>
			isLayer
				? addLayerMember(layerId, id, newRole as LayerRoleName)
				: addMapMember(id, newRole as Role),
		);
		if (ok) {
			setNewId("");
			showNotice("Member added.");
		}
	};

	return (
		<section class="members">
			<h3 class="section-title">Members</h3>
			{members === null && <p class="muted">Loading…</p>}
			<ul class="member-list">
				{members?.map((m) => (
					<li key={m.userId}>
						{m.avatarUrl ? (
							<img
								class="avatar"
								src={m.avatarUrl}
								alt=""
								width={24}
								height={24}
							/>
						) : (
							<span class="avatar placeholder" />
						)}
						<span class="member-name">
							{m.username}
							{m.userId === user.value?.id && <span class="muted"> (you)</span>}
						</span>
						<select
							value={m.role}
							disabled={busy}
							aria-label={`Role of ${m.username}`}
							title={ROLE_HELP[m.role]}
							onChange={(e) => void changeRole(m, e.currentTarget.value)}
						>
							{roles.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
						<button
							type="button"
							class="btn small danger"
							disabled={busy}
							onClick={() => remove(m)}
						>
							Remove
						</button>
					</li>
				))}
			</ul>

			<form class="add-member" onSubmit={add}>
				<input
					type="text"
					inputMode="numeric"
					placeholder="Discord user id"
					aria-label="Discord user id"
					value={newId}
					onInput={(e) => setNewId(e.currentTarget.value)}
				/>
				<select
					value={newRole}
					aria-label="Role"
					onChange={(e) => setNewRole(e.currentTarget.value)}
				>
					{roles.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</select>
				<button type="submit" class="btn" disabled={busy || !newId.trim()}>
					Add
				</button>
			</form>
			<p class="muted hint">
				They must have logged in once. Enable Developer Mode in Discord and use
				“Copy User ID”, or just send an invite link.
			</p>
		</section>
	);
}

import { ROLES_DESCENDING, type Role } from "@aomc/shared";
import { useEffect, useState } from "preact/hooks";
import { showNotice } from "../api";
import type { Member, Scope } from "../sharing";
import { user } from "../state";

/** Highest role first, then by name. */
const sortMembers = <R extends string>(list: Member<R>[]) =>
	[...list].sort(
		(a, b) =>
			ROLES_DESCENDING.indexOf(a.role as Role) -
				ROLES_DESCENDING.indexOf(b.role as Role) ||
			a.username.localeCompare(b.username),
	);

/** Members of the map or of one private layer: change roles, remove people, add by Discord id. */
export function MembersSection<R extends string>(props: {
	scope: Scope<R>;
	/** Whose access is fixed (a layer's creator): shown as "creator", without controls. */
	creatorId?: string;
}) {
	const { scope, creatorId } = props;
	const [members, setMembers] = useState<Member<R>[] | null>(null);
	const [newId, setNewId] = useState("");
	const [newRole, setNewRole] = useState<R>(scope.defaultRole);
	const [busy, setBusy] = useState(false);

	const reload = async () => {
		const list = await scope.load();
		if (list) setMembers(sortMembers(list));
	};
	useEffect(() => {
		setMembers(null);
		setNewRole(scope.defaultRole);
		void reload();
	}, [scope.key]);

	const act = async (fn: () => Promise<boolean>) => {
		setBusy(true);
		let done = false;
		try {
			done = await fn();
		} finally {
			setBusy(false);
		}
		if (done) await reload();
		return done;
	};

	const remove = (m: Member<R>) => {
		const self = m.userId === user.value?.id;
		const ask = self ? "Leave? You may lose access." : `Remove ${m.username}?`;
		if (confirm(ask)) void act(() => scope.remove(m.userId));
	};

	const add = async (e: Event) => {
		e.preventDefault();
		const id = newId.trim();
		if (!id) return;
		if (id === creatorId) {
			showNotice("The creator always has editor access.", "error");
			return;
		}
		if (await act(() => scope.add(id, newRole))) {
			setNewId("");
			showNotice("Member added.");
		}
	};

	const roleOf = (value: string) => scope.roles.find((r) => r === value);

	const roleOptions = scope.roles.map((r) => (
		<option key={r} value={r}>
			{r}
		</option>
	));

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
						{m.userId === creatorId ? (
							<span class="muted" title="The creator always has editor access">
								creator
							</span>
						) : (
							<>
								<select
									value={m.role}
									disabled={busy}
									aria-label={`Role of ${m.username}`}
									title={scope.roleHelp[m.role]}
									onChange={async (e) => {
										const select = e.currentTarget;
										const role = roleOf(select.value);
										if (!role) return;
										// A rejected change leaves the control showing what is really set.
										if (!(await act(() => scope.setRole(m.userId, role))))
											select.value = m.role;
									}}
								>
									{roleOptions}
								</select>
								<button
									type="button"
									class="btn small danger"
									disabled={busy}
									onClick={() => remove(m)}
								>
									Remove
								</button>
							</>
						)}
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
					onChange={(e) =>
						setNewRole(roleOf(e.currentTarget.value) ?? scope.defaultRole)
					}
				>
					{roleOptions}
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

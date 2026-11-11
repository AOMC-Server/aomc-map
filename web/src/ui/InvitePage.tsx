import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { loadUser } from "../controller";
import { user } from "../state";

type Preview = {
	kind: "map" | "layer";
	role: string;
	mapName: string;
	mapSlug: string;
	layerName: string | null;
	inviterName: string;
	alreadyMember: boolean;
};

type State =
	| { phase: "loading" }
	| { phase: "ready"; invite: Preview }
	| { phase: "accepting"; invite: Preview }
	| { phase: "invalid"; message: string }
	| { phase: "failed"; invite: Preview; message: string };

export const inviteTokenFromPath = (path: string): string | null => {
	const m = /^\/invite\/([^/?#]+)\/?$/.exec(path);
	return m ? decodeURIComponent(m[1] as string) : null;
};

const mapLink = (slug: string) => `/?map=${encodeURIComponent(slug)}`;

/** /invite/<token>: log in if needed, accept, and land on the map. */
export function InvitePage(props: { token: string }) {
	const { token } = props;
	const [state, setState] = useState<State>({ phase: "loading" });
	const autoAccept = new URLSearchParams(location.search).get("accept") === "1";

	const accept = async (invite: Preview) => {
		setState({ phase: "accepting", invite });
		const res = await api.api.invites[":token"].accept.$post({
			param: { token },
		});
		if (res.ok) {
			location.replace(mapLink(invite.mapSlug));
			return;
		}
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		setState({
			phase: "failed",
			invite,
			message: body.error ?? `Could not accept (${res.status}).`,
		});
	};

	useEffect(() => {
		void (async () => {
			await loadUser();
			const res = await api.api.invites[":token"].$get({ param: { token } });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setState({
					phase: "invalid",
					message: body.error ?? "This invite link is not valid.",
				});
				return;
			}
			const { invite } = (await res.json()) as { invite: Preview };
			if (invite.alreadyMember) {
				location.replace(mapLink(invite.mapSlug));
				return;
			}
			setState({ phase: "ready", invite });
			if (autoAccept && user.value) void accept(invite);
		})();
	}, [token]);

	const loginHref = `/auth/discord?returnTo=${encodeURIComponent(`/invite/${token}?accept=1`)}`;

	return (
		<main class="invite-page">
			<div class="modal invite-card">
				<h1>AOMC Map</h1>
				{state.phase === "loading" && <p class="muted">Checking invite…</p>}

				{state.phase === "invalid" && (
					<>
						<p class="error-text">{state.message}</p>
						<a class="btn" href="/">
							Open the map
						</a>
					</>
				)}

				{(state.phase === "ready" ||
					state.phase === "accepting" ||
					state.phase === "failed") && (
					<>
						<p>
							<b>{state.invite.inviterName}</b> invited you to{" "}
							{state.invite.kind === "layer" ? (
								<>
									the private layer <b>{state.invite.layerName}</b> on{" "}
									<b>{state.invite.mapName}</b>
								</>
							) : (
								<>
									<b>{state.invite.mapName}</b>
								</>
							)}{" "}
							as <b>{state.invite.role}</b>.
						</p>
						{state.phase === "failed" && (
							<p class="error-text">{state.message}</p>
						)}
						{user.value ? (
							<div class="modal-actions">
								<button
									type="button"
									class="btn primary"
									disabled={state.phase === "accepting"}
									onClick={() => accept(state.invite)}
								>
									{state.phase === "accepting" ? "Joining…" : "Accept invite"}
								</button>
								<span class="muted">as {user.value.username}</span>
							</div>
						) : (
							<div class="modal-actions">
								<a class="btn primary" href={loginHref}>
									Log in with Discord to accept
								</a>
							</div>
						)}
					</>
				)}
			</div>
		</main>
	);
}

import type { InferResponseType } from "hono/client";
import { useEffect, useState } from "preact/hooks";
import { api, attempt, loginUrl } from "../api";
import { loadUser } from "../controller";
import { user } from "../state";

type Preview = InferResponseType<
	(typeof api.api.invites)[":token"]["$get"],
	200
>["invite"];

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

/** /invite/<token>: log in if needed, accept, and land on the map. */
export function InvitePage(props: { token: string }) {
	const { token } = props;
	const [state, setState] = useState<State>({ phase: "loading" });
	const autoAccept = new URLSearchParams(location.search).get("accept") === "1";

	const accept = async (invite: Preview) => {
		setState({ phase: "accepting", invite });
		const result = await attempt(() =>
			api.api.invites[":token"].accept.$post({ param: { token } }),
		);
		if (result.ok) {
			location.replace("/");
			return;
		}
		setState({ phase: "failed", invite, message: result.error });
	};

	useEffect(() => {
		void (async () => {
			await loadUser();
			const result = await attempt(() =>
				api.api.invites[":token"].$get({ param: { token } }),
			);
			if (!result.ok) {
				setState({ phase: "invalid", message: result.error });
				return;
			}
			const { invite } = result.body;
			if (invite.alreadyMember) {
				location.replace("/");
				return;
			}
			setState({ phase: "ready", invite });
			if (autoAccept && user.value) void accept(invite);
		})();
	}, [token]);

	const loginHref = loginUrl(`/invite/${token}?accept=1`);

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
								<b>{state.invite.mapName}</b>
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

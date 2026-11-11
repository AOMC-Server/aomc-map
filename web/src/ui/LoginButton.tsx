import { useEffect, useRef, useState } from "preact/hooks";
import { loginUrl, logout } from "../api";
import { user } from "../state";

export function LoginButton() {
	const u = user.value;
	// On small screens the account buttons stay folded away behind the avatar until it is tapped.
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!u) {
		return (
			<div class="account dock">
				<a class="btn" href="/stats" title="Statistics and leaderboard">
					Stats
				</a>
				<a
					class="btn"
					href="/privacy"
					title="What the site keeps about you, and why"
				>
					Privacy
				</a>
				<a class="btn primary" href={loginUrl()}>
					Log in with Discord
				</a>
			</div>
		);
	}
	return (
		<div class={`account dock ${open ? "open" : ""}`} ref={ref}>
			<button
				type="button"
				class="player"
				aria-expanded={open}
				aria-label={`${u.username}: account menu`}
				onClick={() => setOpen(!open)}
			>
				{u.avatarUrl ? (
					<img class="avatar" src={u.avatarUrl} alt="" width={28} height={28} />
				) : (
					<span class="avatar placeholder" />
				)}
				<span class="username">{u.username}</span>
			</button>
			<a
				class="btn account-action"
				href="/stats"
				title="Your stats and the leaderboard"
			>
				Stats
			</a>
			<a
				class="btn account-action"
				href="/settings"
				title="Your settings and API tokens"
			>
				Settings
			</a>
			<a
				class="btn account-action"
				href="/privacy"
				title="What the site keeps about you, and why"
			>
				Privacy
			</a>
			<button
				type="button"
				class="btn account-action"
				onClick={async () => {
					await logout();
					location.reload();
				}}
			>
				Log out
			</button>
		</div>
	);
}

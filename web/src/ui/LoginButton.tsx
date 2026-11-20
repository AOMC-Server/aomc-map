import { useEffect, useRef, useState } from "preact/hooks";
import { loginUrl, logout } from "../api";
import { user } from "../state";
import { type IconName, PixelIcon } from "./icons";

/** Icon for small screens, where only it is shown, and the label for the rest. */
function ActionContent(props: { icon: IconName; label: string }) {
	return (
		<>
			<PixelIcon class="account-icon" name={props.icon} size={24} />
			<span class="account-label">{props.label}</span>
		</>
	);
}

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
				aria-label="Stats"
			>
				<ActionContent icon="stats" label="Stats" />
			</a>
			<a
				class="btn account-action"
				href="/settings"
				title="Your settings and API tokens"
				aria-label="Settings"
			>
				<ActionContent icon="settings" label="Settings" />
			</a>
			<a
				class="btn account-action"
				href="/privacy"
				title="What the site keeps about you, and why"
				aria-label="Privacy"
			>
				<ActionContent icon="privacy" label="Privacy" />
			</a>
			<button
				type="button"
				class="btn account-action"
				title="Log out"
				aria-label="Log out"
				onClick={async () => {
					await logout();
					location.reload();
				}}
			>
				<ActionContent icon="logout" label="Log out" />
			</button>
		</div>
	);
}

import { loginUrl, logout } from "../api";
import { user } from "../state";

export function LoginButton() {
	const u = user.value;
	if (!u) {
		return (
			<div class="account">
				<a class="btn primary" href={loginUrl()}>
					Log in with Discord
				</a>
			</div>
		);
	}
	return (
		<div class="account">
			<span class="player">
				{u.avatarUrl ? (
					<img class="avatar" src={u.avatarUrl} alt="" width={28} height={28} />
				) : (
					<span class="avatar placeholder" />
				)}
				<span class="username">{u.username}</span>
			</span>
			<a class="btn" href="/settings" title="Your settings and API tokens">
				Settings
			</a>
			<button
				type="button"
				class="btn"
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

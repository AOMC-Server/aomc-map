import { loginUrl, logout } from "../api";
import { user } from "../state";

export function LoginButton() {
	const u = user.value;
	if (!u) {
		return (
			<a class="btn primary" href={loginUrl()}>
				Log in with Discord
			</a>
		);
	}
	return (
		<div class="account">
			{u.avatarUrl && (
				<img class="avatar" src={u.avatarUrl} alt="" width={24} height={24} />
			)}
			<span class="username">{u.username}</span>
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

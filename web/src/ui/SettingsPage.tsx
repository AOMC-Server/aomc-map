import { useEffect, useState } from "preact/hooks";
import { loginUrl } from "../api";
import { loadMapDetail, loadUser } from "../controller";
import { type Settings, settings, updateSettings } from "../settings";
import { user, visibleDimensions } from "../state";
import { ApiTokens } from "./ApiTokens";
import { Page } from "./Page";

function Toggle(props: {
	field: Exclude<keyof Settings, "defaultDimension">;
	label: string;
	hint: string;
}) {
	return (
		<label class="toggle">
			<input
				type="checkbox"
				checked={settings.value[props.field]}
				onChange={(e) =>
					updateSettings({ [props.field]: e.currentTarget.checked })
				}
			/>
			<span>
				{props.label}
				<span class="muted hint">{props.hint}</span>
			</span>
		</label>
	);
}

function Preferences() {
	const dims = visibleDimensions.value;
	const current = settings.value.defaultDimension;
	return (
		<section class="page-section">
			<h2>Preferences</h2>
			<p class="muted">Saved in this browser only.</p>

			<label class="field">
				<span class="label">Open the map in</span>
				<select
					value={current ?? ""}
					onChange={(e) =>
						updateSettings({ defaultDimension: e.currentTarget.value || null })
					}
				>
					<option value="">The first dimension</option>
					{dims.map((d) => (
						<option key={d.slug} value={d.slug}>
							{d.name}
						</option>
					))}
					{current && !dims.some((d) => d.slug === current) && (
						<option value={current}>{current} (unavailable)</option>
					)}
				</select>
				<span class="muted hint">
					Used when the link doesn't name a dimension.
				</span>
			</label>

			<Toggle
				field="rememberPosition"
				label="Remember where I was"
				hint="Reopen the map at your last position and dimension when the link doesn't name one."
			/>
			<Toggle
				field="showCoordinates"
				label="Show cursor coordinates"
				hint="In the bottom left corner, like the F3 screen."
			/>
			<Toggle
				field="showOverworldEquivalent"
				label="Show overworld coordinates in other dimensions"
				hint="In the Nether, also show the matching overworld position."
			/>
			<Toggle
				field="showScale"
				label="Show the zoom scale"
				hint="For example “1 px = 4 blocks”."
			/>
		</section>
	);
}

/** /settings: your preferences and API tokens. */
export function SettingsPage() {
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		void Promise.all([loadUser(), loadMapDetail()]).then(() => setLoaded(true));
	}, []);

	const u = user.value;
	return (
		<Page title="Settings">
			{u && (
				<section class="page-section account-card">
					{u.avatarUrl && (
						<img
							class="avatar"
							src={u.avatarUrl}
							alt=""
							width={40}
							height={40}
						/>
					)}
					<div>
						<div>{u.username}</div>
						<div class="muted hint">
							Name and avatar come from Discord and update when you log in.
						</div>
					</div>
				</section>
			)}

			<Preferences />

			{!loaded ? null : u ? (
				<ApiTokens />
			) : (
				<section class="page-section">
					<h2>API tokens</h2>
					<p class="muted">Log in to create API tokens.</p>
					<a class="btn primary" href={loginUrl()}>
						Log in with Discord
					</a>
				</section>
			)}
		</Page>
	);
}

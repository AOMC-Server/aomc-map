import { useEffect, useState } from "preact/hooks";
import { api, attempt, loginUrl } from "../api";
import {
	isMapOutlines,
	MAP_OUTLINE_CHOICES,
	type Settings,
	settings,
	TRANSITION_SPEEDS,
	updateSettings,
} from "../settings";
import { user, visibleDimensions } from "../state";
import { MODES, STYLES } from "../theme";
import { ApiTokens } from "./ApiTokens";
import { LoadFailed, Page, usePageLoad } from "./Page";

type BooleanSetting = {
	[K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

function Toggle(props: { field: BooleanSetting; label: string; hint: string }) {
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

function ModePicker() {
	const current = settings.value.mode;
	return (
		<fieldset class="mode-picker">
			<legend class="label">Colours</legend>
			<div class="segmented">
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						class={`btn ${m.id === current ? "active" : ""}`}
						aria-pressed={m.id === current}
						onClick={() => updateSettings({ mode: m.id })}
					>
						{m.name}
					</button>
				))}
			</div>
		</fieldset>
	);
}

function StylePicker() {
	const current = settings.value.style;
	return (
		<fieldset class="style-picker">
			<legend class="label">Style</legend>
			{STYLES.map((st) => (
				<label
					key={st.id}
					class={`style-option ${st.id === current ? "selected" : ""}`}
				>
					<input
						class="visually-hidden"
						type="radio"
						name="style"
						value={st.id}
						checked={st.id === current}
						onChange={() => updateSettings({ style: st.id })}
					/>
					<span class="style-preview" data-style={st.id} aria-hidden="true">
						<span class="preview-window">
							<span class="preview-head">Layers</span>
							<span class="preview-body">
								<span class="btn small">Edit</span>
								<span class="btn small primary">Save</span>
							</span>
						</span>
					</span>
					<span class="style-name">{st.name}</span>
					<span class="muted hint">{st.hint}</span>
				</label>
			))}
		</fieldset>
	);
}

function Appearance() {
	return (
		<section class="page-section">
			<h2>Appearance</h2>
			<p class="muted">Saved in this browser only.</p>
			<ModePicker />
			<StylePicker />
			<Toggle
				field="dimensionColours"
				label="Colour the map by dimension"
				hint="Use the viewed dimension's colours, like the Nether's reds or the End's purples. Otherwise the overworld's are used everywhere."
			/>
		</section>
	);
}

function TransitionPicker() {
	const current = settings.value.transitionSpeed;
	return (
		<fieldset class="mode-picker">
			<legend class="label">Camera transitions</legend>
			<div class="segmented">
				{TRANSITION_SPEEDS.map((t) => (
					<button
						key={t.id}
						type="button"
						class={`btn ${t.id === current ? "active" : ""}`}
						aria-pressed={t.id === current}
						onClick={() => updateSettings({ transitionSpeed: t.id })}
					>
						{t.name}
					</button>
				))}
			</div>
			<span class="muted hint">
				How quickly the map moves and zooms to a place, for example when you
				open an upload. Instant skips the animation.
			</span>
		</fieldset>
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

			<TransitionPicker />

			<Toggle
				field="rememberPosition"
				label="Remember where I was"
				hint="Reopen the map at your last position and dimension when the link doesn't name one."
			/>
			<Toggle
				field="showCoordinates"
				label="Show cursor coordinates"
				hint="In the bottom left corner of the map."
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
			<Toggle
				field="preloadSpawn"
				label="Preload the area around spawn"
				hint="Load low resolution images of the area around spawn in the background, so there is always something to show there while the detailed ones load. Turn off to save data on a slow or metered connection."
			/>
		</section>
	);
}

function Debugging() {
	return (
		<section class="page-section">
			<h2>Debugging</h2>
			<p class="muted">Saved in this browser only.</p>
			<Toggle
				field="debugRender"
				label="Debug render mode"
				hint="Colour each map tile by how it was drawn (loaded, stale, stand-in, missing), label it, and show renderer statistics on the map."
			/>
			<Toggle
				field="tileOutlines"
				label="Show tile outlines"
				hint="Draw the edges of the map tiles at the current zoom level."
			/>
			<Toggle
				field="chunkOutlines"
				label="Show chunk outlines"
				hint="Draw the 16×16 block chunk grid from 1:1 zoom inwards. Zoom in further for chunk coordinates, then the block grid, then each block's coordinates."
			/>
			<Toggle
				field="regionOutlines"
				label="Show region outlines"
				hint="Draw the 512×512 block region grid, labelled with each region's file name (r.X.Z)."
			/>
			<label class="toggle toggle-select">
				<select
					value={settings.value.mapOutlines}
					onChange={(e) => {
						const value = e.currentTarget.value;
						if (isMapOutlines(value)) updateSettings({ mapOutlines: value });
					}}
				>
					{MAP_OUTLINE_CHOICES.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
						</option>
					))}
				</select>
				<span>
					Show in-game map outlines
					<span class="muted hint">
						Draw the areas in-game maps of that size cover. Zoom in for each
						map's centre. All scales draws them nested, each in its own colour:
						1:1 yellow, 1:2 orange, 1:4 red, 1:8 purple, 1:16 green.
					</span>
				</span>
			</label>
		</section>
	);
}

/** Download everything stored about you, or delete your account. */
function YourData() {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Linked to from the privacy statement; the section only appears once the page has loaded.
	useEffect(() => {
		if (location.hash === "#your-data")
			document.getElementById("your-data")?.scrollIntoView();
	}, []);

	const remove = async () => {
		setBusy(true);
		setError(null);
		const res = await attempt(() => api.api.me.$delete());
		setBusy(false);
		if (res.ok) location.href = "/";
		else setError(res.error);
	};

	return (
		<section class="page-section" id="your-data">
			<h2>Your data</h2>
			<p class="muted">
				What the site keeps about you and why is described in the{" "}
				<a href="/privacy">privacy statement</a>.
			</p>
			<div class="group">
				<a class="btn" href="/api/me/export" download="my-map-data.json">
					Download my data
				</a>
				{!confirming && (
					<button
						type="button"
						class="btn danger"
						onClick={() => setConfirming(true)}
					>
						Delete my account
					</button>
				)}
			</div>
			{confirming && (
				<div class="delete-account">
					<p>
						This logs you out everywhere and deletes your account, your API
						tokens, your roles and the invites you made. It cannot be undone.
					</p>
					<p>
						Your uploads, layers and features stay on the map under the name
						“Deleted user”, with nothing left that leads back to you. Delete any
						of them first if you want them gone. Logging in again later starts a
						new, empty account.
					</p>
					<div class="group">
						<button
							type="button"
							class="btn danger"
							disabled={busy}
							onClick={() => void remove()}
						>
							{busy ? "Deleting…" : "Yes, delete my account"}
						</button>
						<button
							type="button"
							class="btn"
							disabled={busy}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
					</div>
					{error && <p class="error-text">{error}</p>}
				</div>
			)}
		</section>
	);
}

/** /settings: your preferences and API tokens. */
export function SettingsPage() {
	const { status, retry } = usePageLoad();

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

			<Appearance />
			<Preferences />
			<Debugging />

			{status === "loading" ? null : status === "failed" ? (
				<section class="page-section">
					<LoadFailed retry={retry} />
				</section>
			) : u ? (
				<>
					<ApiTokens />
					<YourData />
				</>
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

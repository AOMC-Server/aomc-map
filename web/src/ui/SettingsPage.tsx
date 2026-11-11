import { useEffect, useState } from "preact/hooks";
import { loginUrl } from "../api";
import { loadMapDetail, loadUser } from "../controller";
import {
	type Settings,
	settings,
	TRANSITION_SPEEDS,
	updateSettings,
} from "../settings";
import { user, visibleDimensions } from "../state";
import { MODES, STYLES } from "../theme";
import { ApiTokens } from "./ApiTokens";
import { Page } from "./Page";

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

			<Appearance />
			<Preferences />
			<Debugging />

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

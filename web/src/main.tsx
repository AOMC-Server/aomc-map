import { effect } from "@preact/signals";
import { render } from "preact";
import { fontSizeFor } from "./fontScale";
import { settings } from "./settings";
import { currentDimensionTheme, currentMap, dimSlug } from "./state";
import {
	applyAppearance,
	prefersLight,
	resolveMode,
	savePalette,
} from "./theme";
import { App } from "./ui/App";
import { InvitePage, inviteTokenFromPath } from "./ui/InvitePage";
import { ManagePage } from "./ui/ManagePage";
import { SettingsPage } from "./ui/SettingsPage";
import { StatsPage } from "./ui/StatsPage";
import "./styles.css";

// Browser zoom changes the pixel ratio, so keep the pixel font of the headings crisp as it changes.
const applyFontSize = () =>
	document.documentElement.style.setProperty(
		"--fs-display",
		`${fontSizeFor(window.devicePixelRatio || 1)}px`,
	);
applyFontSize();
window.addEventListener("resize", applyFontSize);

const inviteToken = inviteTokenFromPath(location.pathname);
const path = location.pathname.replace(/\/+$/, "");
const onMap =
	!inviteToken &&
	path !== "/settings" &&
	path !== "/manage" &&
	path !== "/stats";

effect(() => {
	const s = settings.value;
	const dim = onMap ? dimSlug.value : null;
	// Only the map follows a dimension; the other pages use the overworld colours.
	const palette =
		dim && s.dimensionColours ? currentDimensionTheme.value : "overworld";
	applyAppearance({
		mode: resolveMode(s.mode, prefersLight.value),
		palette,
		style: s.style,
	});
	if (dim && currentMap.value) savePalette({ dim, palette });
});

render(
	inviteToken ? (
		<InvitePage token={inviteToken} />
	) : path === "/settings" ? (
		<SettingsPage />
	) : path === "/manage" ? (
		<ManagePage />
	) : path === "/stats" ? (
		<StatsPage />
	) : (
		<App />
	),
	document.getElementById("app") as HTMLElement,
);

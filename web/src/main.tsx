import { render } from "preact";
import { fontSizeFor } from "./fontScale";
import { App } from "./ui/App";
import { InvitePage, inviteTokenFromPath } from "./ui/InvitePage";
import { ManagePage } from "./ui/ManagePage";
import { SettingsPage } from "./ui/SettingsPage";
import "./styles.css";

// Browser zoom changes the pixel ratio, so keep the pixel font crisp as it changes.
const applyFontSize = () =>
	document.documentElement.style.setProperty(
		"--fs",
		`${fontSizeFor(window.devicePixelRatio || 1)}px`,
	);
applyFontSize();
window.addEventListener("resize", applyFontSize);

const inviteToken = inviteTokenFromPath(location.pathname);
const path = location.pathname.replace(/\/+$/, "");

render(
	inviteToken ? (
		<InvitePage token={inviteToken} />
	) : path === "/settings" ? (
		<SettingsPage />
	) : path === "/manage" ? (
		<ManagePage />
	) : (
		<App />
	),
	document.getElementById("app") as HTMLElement,
);

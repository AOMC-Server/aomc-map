import { render } from "preact";
import { App } from "./ui/App";
import { InvitePage, inviteTokenFromPath } from "./ui/InvitePage";
import { ManagePage } from "./ui/ManagePage";
import { SettingsPage } from "./ui/SettingsPage";
import "./styles.css";

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

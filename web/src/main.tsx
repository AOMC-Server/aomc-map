import { render } from "preact";
import { App } from "./ui/App";
import { InvitePage, inviteTokenFromPath } from "./ui/InvitePage";
import "./styles.css";

const inviteToken = inviteTokenFromPath(location.pathname);

render(
	inviteToken ? <InvitePage token={inviteToken} /> : <App />,
	document.getElementById("app") as HTMLElement,
);

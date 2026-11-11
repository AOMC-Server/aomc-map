import type { ComponentChildren } from "preact";
import { currentMap, user } from "../state";
import { Page, usePageLoad } from "./Page";

/** When the statement last changed in substance; update it with the text. */
const UPDATED = "11 November 2026";

/** A contact that looks like an e-mail address or a web address becomes a link. */
function Contact(props: { value: string }) {
	const v = props.value;
	if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
		return <a href={`mailto:${v}`}>{v}</a>;
	if (/^https?:\/\//.test(v))
		return (
			<a href={v} target="_blank" rel="noopener noreferrer">
				{v}
			</a>
		);
	return <>{v}</>;
}

function Section(props: { title: string; children: ComponentChildren }) {
	return (
		<section class="page-section privacy">
			<h2>{props.title}</h2>
			{props.children}
		</section>
	);
}

/** /privacy: what the site keeps about people, why, for how long, and what they can do about it. */
export function PrivacyPage() {
	const { status } = usePageLoad();
	const detail = currentMap.value;
	const controller = detail?.privacy.controller ?? "";
	const contact = detail?.privacy.contact ?? "";
	const site = detail?.map.name ?? "this map";
	const loggedIn = user.value !== null;

	return (
		<Page title="Privacy">
			<Section title="In short">
				<p>
					{site} is a shared Minecraft map. It keeps what it needs to run the
					map and to show who contributed what, and nothing more: no ads, no
					analytics, no tracking cookies, and nothing is sold or shared for
					marketing. Looking at the map without logging in leaves no personal
					data behind.
				</p>
				<p class="muted">Last updated {UPDATED}.</p>
			</Section>

			<Section title="Who is responsible">
				{status === "loading" ? (
					<p class="muted">Loading…</p>
				) : controller || contact ? (
					<p>
						The personal data on this site is the responsibility of{" "}
						<b>{controller || "the operator of this site"}</b> (the controller
						under the EU General Data Protection Regulation, GDPR).
						{contact && (
							<>
								{" "}
								For questions, a copy of your data or anything else about
								privacy, contact <Contact value={contact} />.
							</>
						)}
					</p>
				) : (
					<p>
						The operator of this site has not filled in their contact details
						yet. Until they do, ask a moderator of the map.
					</p>
				)}
			</Section>

			<Section title="When you only look at the map">
				<ul>
					<li>
						Your <b>IP address</b> is used for a moment, in memory, to limit how
						many short links and preview images one visitor can make per minute.
						It is never written to disk, and the site keeps no access logs with
						IP addresses.
					</li>
					<li>
						The server counts its traffic in total (how many requests and bytes,
						per hour and kind of request), with nothing that tells visitors
						apart.
					</li>
					<li>
						Your settings (appearance, preferences) and where you last were on
						the map are saved in <b>your own browser</b> (local storage). They
						are never sent to the server; clearing your browser's site data
						removes them.
					</li>
				</ul>
			</Section>

			<Section title="When you log in with Discord">
				<p>
					Logging in goes through Discord. The site asks Discord only for your
					basic profile (the <code>identify</code> permission), so it never sees
					your e-mail address, your servers or your messages. It keeps:
				</p>
				<ul>
					<li>
						your Discord <b>user id</b>, <b>display name</b> and a link to your{" "}
						<b>avatar</b>, refreshed each time you log in;
					</li>
					<li>when your account was created and when you last logged in;</li>
					<li>
						your <b>role</b> on the map, if you have been made a moderator or
						owner, and which private layers you have been invited to.
					</li>
				</ul>
				<p>
					Two cookies are used, both only to keep you logged in safely: a{" "}
					<b>session cookie</b> that lasts 30 days and is renewed while you use
					the site (the server keeps only a hash of it), and a short-lived
					cookie during login that protects against forged logins. They are
					strictly necessary for logging in, so they need no consent under the
					Swedish Electronic Communications Act (lagen om elektronisk
					kommunikation). There are no other cookies.
				</p>
			</Section>

			<Section title="What you add to the map">
				<p>
					Everything you contribute is stored together with your account, and
					your name is shown next to it:
				</p>
				<ul>
					<li>
						<b>Uploads</b>: the map images, where they are, how many files, when
						the export was made, and whether it came from the in-game mod.
					</li>
					<li>
						<b>Layers and features</b> (pins, lines and areas) with their names,
						texts and positions, including every earlier version and deleted
						ones, so changes can be followed and undone.
					</li>
					<li>
						<b>Invites</b> and <b>short links</b> you make, and{" "}
						<b>API tokens</b> (their names, permissions and when they were used;
						only a hash of the secret is kept).
					</li>
				</ul>
				<p>
					Anyone can see the map, so your name is public next to your uploads,
					in the history of features, and on the statistics page with its
					leaderboard. Private layers are only shown to the people invited to
					them and to the map's moderators.
				</p>
			</Section>

			<Section title="Why, and on what legal basis">
				<ul>
					<li>
						Your account and your contributions are needed to give you what you
						sign up for: logging in, and adding to and editing the shared map
						(GDPR article 6(1)(b), performance of a contract).
					</li>
					<li>
						Showing who contributed what, keeping the history of changes,
						limiting requests per visitor and counting traffic keep the map
						trustworthy, safe from abuse and running (article 6(1)(f),
						legitimate interests). You can object to this; see below.
					</li>
				</ul>
				<p>
					No decisions about you are made automatically, and nothing is used for
					profiling.
				</p>
			</Section>

			<Section title="Who else is involved">
				<ul>
					<li>
						<b>Discord</b> handles the login, under its own{" "}
						<a
							href="https://discord.com/privacy"
							target="_blank"
							rel="noopener noreferrer"
						>
							privacy policy
						</a>
						. Avatars are shown straight from Discord's servers, so Discord sees
						the IP address of anyone whose browser shows an avatar. Discord is
						based in the United States.
					</li>
					<li>
						The site is <b>hosted in the EU/EEA</b>. The hosting provider stores
						the data on the operator's behalf and may not use it for anything
						else.
					</li>
				</ul>
				<p>Nothing is shared with anyone else.</p>
			</Section>

			<Section title="How long it is kept">
				<ul>
					<li>
						Your account: until you delete it. A session ends 30 days after you
						last used the site, or when you log out.
					</li>
					<li>
						Your contributions: as long as the map exists, since others build on
						them. When you delete your account they stay, but under the name
						“Deleted user”, with nothing left that leads back to you. You can
						delete your own features at any time, and your own uploads for a
						while after making them; ask a moderator or the contact above to
						remove anything else.
					</li>
					<li>
						Backups of the site may hold deleted data until they are replaced by
						newer ones.
					</li>
				</ul>
			</Section>

			<Section title="Your rights">
				<p>
					Under the GDPR you may ask for a copy of your data, have it corrected
					or deleted, restrict or object to how it is used, and get it in a form
					you can take elsewhere.{" "}
					{loggedIn ? (
						<>
							Most of this you can do yourself in{" "}
							<a href="/settings#your-data">Settings</a>: download your data as
							a JSON file, or delete your account.
						</>
					) : (
						<>
							Once logged in, you can download your data or delete your account
							yourself under Settings.
						</>
					)}{" "}
					Your name and avatar follow your Discord profile and update when you
					log in again. For anything else, use the contact above.
				</p>
				<p>
					If you think your data is handled wrongly, you can complain to the
					Swedish Authority for Privacy Protection,{" "}
					<a
						href="https://www.imy.se/"
						target="_blank"
						rel="noopener noreferrer"
					>
						Integritetsskyddsmyndigheten (IMY)
					</a>
					, or to the authority where you live.
				</p>
			</Section>
		</Page>
	);
}

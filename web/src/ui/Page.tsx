import type { ComponentChildren } from "preact";
import { Toast } from "./Toast";

/** Layout of the standalone pages (/settings, /manage): a menu screen with a title, a scrolling list and Done. */
export function Page(props: { title: string; children: ComponentChildren }) {
	return (
		<div class="page-root menu-screen">
			<header class="page-head">
				<h1>{props.title}</h1>
			</header>
			<main class="page">
				<div class="page-inner">{props.children}</div>
			</main>
			<footer class="page-foot">
				<a class="btn wide" href="/">
					Done
				</a>
			</footer>
			<Toast />
		</div>
	);
}

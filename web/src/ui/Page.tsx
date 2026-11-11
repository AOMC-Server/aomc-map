import type { ComponentChildren } from "preact";
import { Toast } from "./Toast";

/** Layout of the standalone pages (/settings, /manage, /stats): a title bar with a way back, and the content. */
export function Page(props: { title: string; children: ComponentChildren }) {
	return (
		<div class="page-root">
			<header class="page-head">
				<a class="btn small" href="/">
					← Map
				</a>
				<h1>{props.title}</h1>
			</header>
			<main class="page">
				<div class="page-inner">{props.children}</div>
			</main>
			<Toast />
		</div>
	);
}

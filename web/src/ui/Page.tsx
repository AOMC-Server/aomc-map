import type { ComponentChildren } from "preact";
import { Toast } from "./Toast";

/** Layout of the standalone pages (/settings, /manage): a back link, a title and the content. */
export function Page(props: { title: string; children: ComponentChildren }) {
	return (
		<div class="page-root">
			<main class="page">
				<div class="page-inner">
					<header class="page-head">
						<a class="btn" href="/">
							← Back to map
						</a>
						<h1>{props.title}</h1>
					</header>
					{props.children}
				</div>
			</main>
			<Toast />
		</div>
	);
}

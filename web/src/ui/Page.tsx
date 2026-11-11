import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loadPageData } from "../controller";
import { Toast } from "./Toast";

/** Loads what a standalone page needs on mount; `retry` tries again after a failure. */
export function usePageLoad() {
	const [status, setStatus] = useState<"loading" | "ready" | "failed">(
		"loading",
	);
	const load = () => {
		setStatus("loading");
		void loadPageData().then((ok) => setStatus(ok ? "ready" : "failed"));
	};
	useEffect(load, []);
	return { status, retry: load };
}

/** Shown when a page could not reach the server. */
export function LoadFailed(props: { retry: () => void }) {
	return (
		<>
			<p class="error-text">
				Could not reach the server. Check your connection and try again.
			</p>
			<button type="button" class="btn" onClick={props.retry}>
				Retry
			</button>
		</>
	);
}

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

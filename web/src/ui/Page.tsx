import { canManage } from "@aomc/shared/roles";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loadPageData } from "../controller";
import { setMaintenance } from "../sharing";
import { currentMap } from "../state";
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

/** Shown at the top of every page while the map is in maintenance. */
function MaintenanceNotice() {
	const detail = currentMap.value;
	const [busy, setBusy] = useState(false);
	if (!detail?.map.maintenance) return null;
	const owner = canManage(detail.role);
	return (
		<div class="maintenance-notice" role="status">
			<p>
				{owner
					? "Maintenance mode is on: the map is read only for everyone but owners."
					: "The map is in maintenance: you can look around, but nothing can be changed until it is over."}
			</p>
			{owner && (
				<button
					type="button"
					class="btn small"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await setMaintenance(false);
						} finally {
							setBusy(false);
						}
					}}
				>
					Turn off
				</button>
			)}
		</div>
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
			<MaintenanceNotice />
			<main class="page">
				<div class="page-inner">{props.children}</div>
			</main>
			<Toast />
		</div>
	);
}

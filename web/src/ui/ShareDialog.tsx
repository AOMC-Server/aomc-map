import type { ShareView } from "@aomc/shared/schemas";
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { api, attempt } from "../api";
import { mapView } from "../controller";
import { currentMap, dimSlug, isLayerHidden, layersData, rev } from "../state";
import { Modal } from "./Modal";
import { copyText } from "./shareCommon";

export const shareOpen = signal(false);

/** What would be shared right now, or null before the map is up. */
function currentView(includeLayers: boolean): ShareView | null {
	const mv = mapView.value;
	const dim = dimSlug.value;
	if (!mv || !dim) return null;
	const v = mv.getView();
	return {
		dim,
		x: Math.round(v.centerX),
		z: Math.round(v.centerZ),
		zoom: Math.round(v.zoom * 100) / 100,
		...(rev.value === null ? {} : { rev: rev.value }),
		...(includeLayers
			? {
					layers: layersData.value
						.filter((l) => !isLayerHidden(l))
						.map((l) => l.id),
				}
			: {}),
	};
}

type LinkState =
	| { phase: "making" }
	| { phase: "ready"; url: string }
	| { phase: "failed"; error: string };

/** Makes a short link to the view on screen: the place, zoom, dimension, revision and layers. */
export function ShareDialog() {
	const [includeLayers, setIncludeLayers] = useState(true);
	// The view as it was when the dialog opened; panning behind it changes nothing.
	const [snapshot] = useState(() => currentView(true));
	const [link, setLink] = useState<LinkState>({ phase: "making" });
	const close = () => {
		shareOpen.value = false;
	};

	const view: ShareView | null = snapshot && {
		...snapshot,
		layers: includeLayers ? snapshot.layers : undefined,
	};
	const key = JSON.stringify(view);

	useEffect(() => {
		if (!view) return;
		let cancelled = false;
		setLink({ phase: "making" });
		void attempt(() => api.api.links.$post({ json: view })).then((res) => {
			if (cancelled) return;
			setLink(
				res.ok
					? { phase: "ready", url: res.body.url }
					: { phase: "failed", error: res.error },
			);
		});
		return () => {
			cancelled = true;
		};
	}, [key]);

	if (!view) return null;
	const dimension = currentMap.value?.dimensions.find(
		(d) => d.slug === view.dim,
	);
	const shown = snapshot?.layers?.length ?? 0;
	const total = layersData.value.length;

	return (
		<Modal title="Share this view" onClose={close}>
			<dl class="share-summary">
				<dt>Dimension</dt>
				<dd>{dimension?.name ?? view.dim}</dd>
				<dt>Position</dt>
				<dd>
					{view.x}, {view.z} <span class="muted">(zoom {view.zoom})</span>
				</dd>
				{view.rev !== undefined && (
					<>
						<dt>Revision</dt>
						<dd>
							{view.rev} <span class="muted">(an earlier version)</span>
						</dd>
					</>
				)}
				<dt>Layers</dt>
				<dd>
					{includeLayers
						? `${shown} of ${total} shown`
						: "Each layer's default"}
				</dd>
			</dl>
			<label class="check">
				<input
					type="checkbox"
					checked={includeLayers}
					onChange={(e) => setIncludeLayers(e.currentTarget.checked)}
				/>
				Show the same layers I have on
			</label>
			<div class="link-row share-link">
				<input
					type="text"
					readOnly
					aria-label="Short link"
					value={link.phase === "ready" ? link.url : ""}
					placeholder={link.phase === "making" ? "Making a link…" : ""}
					onFocus={(e) => e.currentTarget.select()}
				/>
				<button
					type="button"
					class="btn primary"
					disabled={link.phase !== "ready"}
					onClick={() =>
						link.phase === "ready" && void copyText(link.url, "Link copied")
					}
				>
					Copy
				</button>
			</div>
			{link.phase === "failed" && (
				<p class="error-text">Could not make a link: {link.error}</p>
			)}
		</Modal>
	);
}

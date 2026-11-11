import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { InviteLinks } from "./InviteLinks";
import { MembersSection } from "./MembersSection";

/** The private layer whose sharing dialog is open. */
export const layerSharingFor = signal<{ layerId: number; name: string } | null>(
	null,
);

/** Who may see and edit one private layer: members and invite links. */
export function LayerSharing() {
	const target = layerSharingFor.value;

	useEffect(() => {
		if (!target) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") layerSharingFor.value = null;
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [target]);

	if (!target) return null;
	return (
		<div class="modal-backdrop">
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-label="Layer sharing"
			>
				<button
					type="button"
					class="popup-close"
					aria-label="Close"
					onClick={() => (layerSharingFor.value = null)}
				>
					×
				</button>
				<h2>Sharing “{target.name}”</h2>
				<p class="muted">
					Map moderators always see private layers. Everyone else needs to be a
					member here. People must already have access to the map itself.
				</p>
				<MembersSection scope={{ kind: "layer", layerId: target.layerId }} />
				<InviteLinks scope={{ kind: "layer", layerId: target.layerId }} />
			</div>
		</div>
	);
}

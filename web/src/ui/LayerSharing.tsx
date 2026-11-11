import { signal } from "@preact/signals";
import { layerScope } from "../sharing";
import { InviteLinks } from "./InviteLinks";
import { MembersSection } from "./MembersSection";
import { Modal } from "./Modal";

/** The private layer whose sharing dialog is open. */
export const layerSharingFor = signal<{ layerId: number; name: string } | null>(
	null,
);

const close = () => {
	layerSharingFor.value = null;
};

/** Who may see and edit one private layer: members and invite links. */
export function LayerSharing() {
	const target = layerSharingFor.value;
	if (!target) return null;
	const scope = layerScope(target.layerId);
	return (
		<Modal label="Layer sharing" onClose={close}>
			<h2>Sharing “{target.name}”</h2>
			<p class="muted">
				Map moderators always see private layers. Everyone else needs to be a
				member here.
			</p>
			<MembersSection scope={scope} />
			<InviteLinks scope={scope} />
		</Modal>
	);
}

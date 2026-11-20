import type { Dye } from "@aomc/shared/colors";
import type { DimensionTheme } from "@aomc/shared/schemas";

const ICONS = {
	layers: "layers.png",
	history: "history.png",
	measure: "measure.png",
	upload: "upload.png",
	share: "share.png",
	files: "files.png",
	manage: "manage.png",
	file: "file.png",
	archive: "folder.png",
	more: "more.png",
	stats: "stats.png",
	settings: "settings.png",
	privacy: "privacy.png",
	logout: "logout.png",
} as const;

export type IconName = keyof typeof ICONS;

export function PixelIcon(props: {
	name: IconName;
	size?: number;
	class?: string;
}) {
	const size = props.size ?? 32;
	return (
		<img
			class={`pixel-icon ${props.class ?? ""}`}
			src={`/static/icons/${ICONS[props.name]}`}
			alt=""
			width={size}
			height={size}
		/>
	);
}

const BLOCKS: Record<DimensionTheme, string> = {
	overworld: "grass",
	nether: "netherrack",
	end: "endstone",
	unknown: "unknown",
};

/** The block standing for a dimension, from its theme. */
export function BlockIcon(props: { theme: DimensionTheme; size?: number }) {
	const size = props.size ?? 20;
	return (
		<img
			class="block-icon"
			src={`/static/blocks/${BLOCKS[props.theme]}.png`}
			alt=""
			width={size}
			height={size}
		/>
	);
}

/** The banner marker of a dye colour, as drawn on the map. */
export function Banner(props: { dye: Dye; size?: number }) {
	const size = props.size ?? 16;
	return (
		<img
			class="banner"
			src={`/static/markers/${props.dye}_banner.png`}
			alt=""
			width={size}
			height={size}
		/>
	);
}

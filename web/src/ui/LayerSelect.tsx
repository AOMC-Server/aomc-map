import type { Dye } from "@aomc/shared/colors";
import { Banner } from "./icons";
import { PreviewSelect } from "./PreviewSelect";

export type LayerOption = { id: number; name: string; color: Dye };

/** A drop-down list of layers, each with its coloured banner. */
export function LayerSelect(props: {
	options: LayerOption[];
	value: number;
	onChange: (id: number) => void;
}) {
	return (
		<PreviewSelect
			label="Layer"
			value={props.value}
			onChange={props.onChange}
			options={props.options.map((l) => ({
				value: l.id,
				label: l.name,
				dye: l.color,
				preview: <Banner dye={l.color} size={24} />,
			}))}
		/>
	);
}

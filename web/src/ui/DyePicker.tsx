import { DYES, type Dye } from "@aomc/shared/colors";
import { dyeLabel } from "../featureInfo";
import { Banner } from "./icons";

/** Inventory-style grid of the 16 banner colours. With `fallback`, a first slot means "use the layer's colour". */
export function DyePicker(props: {
	value: Dye | null;
	onChange: (dye: Dye | null) => void;
	fallback?: Dye;
	label: string;
}) {
	const slot = (dye: Dye | null, shown: Dye, title: string) => {
		const selected = props.value === dye;
		return (
			<button
				key={dye ?? "default"}
				type="button"
				aria-pressed={selected}
				aria-label={title}
				title={title}
				class={`slot ${selected ? "selected" : ""} ${dye === null ? "default" : ""}`}
				onClick={() => props.onChange(dye)}
			>
				<Banner dye={shown} size={24} />
			</button>
		);
	};
	return (
		<fieldset class="dye-picker" aria-label={props.label}>
			{props.fallback &&
				slot(
					null,
					props.fallback,
					`Layer default (${dyeLabel(props.fallback)})`,
				)}
			{DYES.map((d) => slot(d, d, dyeLabel(d)))}
		</fieldset>
	);
}

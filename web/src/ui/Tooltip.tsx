import { hoverInfo } from "../state";
import { dyeScope } from "../theme";

export function Tooltip() {
	const h = hoverInfo.value;
	if (!h) return null;
	return (
		<div
			class="dye-scope strong"
			{...dyeScope("mix")}
			style={{ "--dye": h.color }}
		>
			<div
				class="tooltip"
				style={{ left: `${h.sx + 14}px`, top: `${h.sy + 16}px` }}
			>
				{h.text}
			</div>
		</div>
	);
}

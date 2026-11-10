import { hoverInfo } from "../state";

export function Tooltip() {
	const h = hoverInfo.value;
	if (!h) return null;
	return (
		<div
			class="tooltip"
			style={{ left: `${h.sx + 14}px`, top: `${h.sy + 16}px` }}
		>
			{h.text}
		</div>
	);
}

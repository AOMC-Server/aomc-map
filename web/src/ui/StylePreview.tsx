import { DYE_HEX, type Dye } from "@aomc/shared/colors";
import { dashPattern } from "@aomc/shared/featureStyle";
import type { AREA_FILLS, LINE_DASHES } from "@aomc/shared/features";
import { fillPatternMarkup, PATTERN_SIZE } from "@aomc/shared/fillPattern";
import { useId } from "preact/hooks";

/** The colour of the swatches when no layer or feature colour is known. */
const NEUTRAL = "#d8d8d8";
const hexOf = (color?: Dye) => (color ? DYE_HEX[color] : NEUTRAL);

/** A stretch of line (as wide as there is room for) drawn the way the map draws it (dark outline under the colour). */
export function DashPreview(props: {
	dash: (typeof LINE_DASHES)[number];
	width: number;
	opacity: number;
	color?: Dye;
}) {
	const { dash, width, opacity } = props;
	const pattern = dashPattern(dash, width);
	const stroke = (color: string, w: number, o: number) => (
		<line
			x1="3%"
			x2="97%"
			y1="8"
			y2="8"
			stroke={color}
			stroke-width={w}
			stroke-opacity={o}
			stroke-linecap="round"
			stroke-dasharray={pattern.length ? pattern.join(" ") : undefined}
		/>
	);
	return (
		<svg class="swatch" width="100%" height="16" aria-hidden="true">
			{stroke("#000", width + 2, 0.55 * opacity)}
			{stroke(hexOf(props.color), width, opacity)}
		</svg>
	);
}

/** A small area filled the way the map fills it. */
export function FillPreview(props: {
	fill: (typeof AREA_FILLS)[number];
	fillOpacity: number;
	/** Of the outline. */
	opacity: number;
	color?: Dye;
}) {
	const { fill, fillOpacity, opacity } = props;
	const id = useId();
	const hex = hexOf(props.color);
	const pattern =
		fill === "stripes" || fill === "crosshatch" || fill === "dots";
	return (
		<svg class="swatch" width="100%" height="24" aria-hidden="true">
			{pattern && (
				<defs>
					<pattern
						id={id}
						width={PATTERN_SIZE}
						height={PATTERN_SIZE}
						patternUnits="userSpaceOnUse"
						dangerouslySetInnerHTML={{ __html: fillPatternMarkup(fill, hex) }}
					/>
				</defs>
			)}
			{fill !== "none" && (
				<rect
					x="2%"
					y="3"
					width="96%"
					height="18"
					fill={pattern ? `url(#${id})` : hex}
					fill-opacity={fillOpacity}
				/>
			)}
			<rect
				x="2%"
				y="3"
				width="96%"
				height="18"
				fill="none"
				stroke="#000"
				stroke-opacity={0.55 * opacity}
				stroke-width="4"
			/>
			<rect
				x="2%"
				y="3"
				width="96%"
				height="18"
				fill="none"
				stroke={hex}
				stroke-opacity={opacity}
				stroke-width="2"
			/>
		</svg>
	);
}

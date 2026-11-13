import {
	AREA_FILLS,
	cleanStyle,
	DEFAULT_AREA_LINE_WIDTH,
	DEFAULT_FILL_OPACITY,
	DEFAULT_LINE_WIDTH,
	type FeatureStyle,
	LINE_DASHES,
	MAX_LINE_WIDTH,
	MIN_LINE_WIDTH,
	mergeStyle,
} from "@aomc/shared/features";

const DASH_LABEL: Record<(typeof LINE_DASHES)[number], string> = {
	solid: "Solid",
	dashed: "Dashed",
	dotted: "Dotted",
};
const FILL_LABEL: Record<(typeof AREA_FILLS)[number], string> = {
	none: "None",
	solid: "Solid",
	stripes: "Stripes",
	crosshatch: "Crosshatch",
	dots: "Dots",
};

const percent = (n: number) => `${Math.round(n * 100)}%`;

/** What a line, an area or a layer (both kinds) is edited as. */
export type StyleKind = "line" | "polygon" | "layer";

/** The style as it is without any setting at all. */
function builtIn(kind: StyleKind): Required<FeatureStyle> {
	return {
		dash: "solid",
		width: kind === "polygon" ? DEFAULT_AREA_LINE_WIDTH : DEFAULT_LINE_WIDTH,
		opacity: 1,
		fill: "solid",
		fillOpacity: DEFAULT_FILL_OPACITY,
		smooth: false,
	};
}

/**
 * Controls for the style of a line, an area or a layer's default. `inherited` is the layer's
 * default style when editing a feature: what a setting shows and falls back to when it is not
 * set. A feature's setting that equals what it inherits is left unset, so that it follows the
 * layer; a layer keeps what is set.
 */
export function StyleControls(props: {
	kind: StyleKind;
	style: FeatureStyle;
	inherited?: FeatureStyle | null;
	onChange: (style: FeatureStyle) => void;
}) {
	const { kind, style, onChange } = props;
	const base = { ...builtIn(kind), ...mergeStyle(props.inherited, null) };
	const shown = { ...base, ...cleanStyle(style) };
	const area = kind !== "line";

	const set = <K extends keyof FeatureStyle>(
		key: K,
		value: FeatureStyle[K],
	) => {
		const next = { ...style, [key]: value };
		if (kind !== "layer" && value === base[key]) delete next[key];
		onChange(next);
	};

	return (
		<div class="style-controls">
			<div class="segmented">
				{LINE_DASHES.map((dash) => (
					<button
						key={dash}
						type="button"
						class={`btn ${shown.dash === dash ? "active" : ""}`}
						aria-pressed={shown.dash === dash}
						onClick={() => set("dash", dash)}
					>
						{DASH_LABEL[dash]}
					</button>
				))}
			</div>
			<label class="slider">
				<span>
					{kind === "polygon" ? "Outline thickness" : "Thickness"}:{" "}
					{shown.width} px
				</span>
				<input
					type="range"
					min={MIN_LINE_WIDTH}
					max={MAX_LINE_WIDTH}
					step={1}
					value={shown.width}
					onInput={(e) => set("width", Number(e.currentTarget.value))}
				/>
			</label>
			<label class="slider">
				<span>
					{kind === "polygon" ? "Outline opacity" : "Opacity"}:{" "}
					{percent(shown.opacity)}
				</span>
				<input
					type="range"
					min={10}
					max={100}
					step={5}
					value={Math.round(shown.opacity * 100)}
					onInput={(e) => set("opacity", Number(e.currentTarget.value) / 100)}
				/>
			</label>
			<label class="check">
				<input
					type="checkbox"
					checked={shown.smooth}
					onChange={(e) => set("smooth", e.currentTarget.checked)}
				/>
				Smooth curves
			</label>
			{area && (
				<>
					<span class="sublabel">
						{kind === "layer" ? "Area fill" : "Fill"}
					</span>
					<div class="segmented wrap">
						{AREA_FILLS.map((fill) => (
							<button
								key={fill}
								type="button"
								class={`btn ${shown.fill === fill ? "active" : ""}`}
								aria-pressed={shown.fill === fill}
								onClick={() => set("fill", fill)}
							>
								{FILL_LABEL[fill]}
							</button>
						))}
					</div>
					<label class="slider">
						<span>Fill opacity: {percent(shown.fillOpacity)}</span>
						<input
							type="range"
							min={0}
							max={100}
							step={5}
							disabled={shown.fill === "none"}
							value={Math.round(shown.fillOpacity * 100)}
							onInput={(e) =>
								set("fillOpacity", Number(e.currentTarget.value) / 100)
							}
						/>
					</label>
				</>
			)}
			<div class="group">
				<button
					type="button"
					class="btn small"
					disabled={cleanStyle(style) === null}
					title={
						kind === "layer"
							? "Back to the built-in look"
							: "Follow the layer's default style"
					}
					onClick={() => onChange({})}
				>
					{kind === "layer" ? "Reset style" : "Use layer default"}
				</button>
			</div>
		</div>
	);
}

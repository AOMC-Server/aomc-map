/** A row of buttons that picks one of a few time ranges. */
export function RangePicker<T extends string>(props: {
	value: T;
	options: readonly T[];
	names: Record<T, string>;
	onChange: (range: T) => void;
}) {
	return (
		<fieldset class="stats-range">
			<legend class="visually-hidden">Time range</legend>
			<div class="segmented">
				{props.options.map((r) => (
					<button
						key={r}
						type="button"
						class={`btn ${r === props.value ? "active" : ""}`}
						aria-pressed={r === props.value}
						onClick={() => props.onChange(r)}
					>
						{props.names[r]}
					</button>
				))}
			</div>
		</fieldset>
	);
}

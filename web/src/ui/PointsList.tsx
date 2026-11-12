import type { Point } from "@aomc/shared/features";
import {
	drawing,
	focusedPoint,
	removePoint,
	selectPoint,
	setPoint,
} from "../tools/draw";
import { lineLength } from "../tools/lineGraph";
import { formatBlocks, pathLength, polygonArea } from "../tools/measureMath";

/** A whole-number field that applies on Enter or when it loses focus, and goes back if it isn't a number. */
function Coordinate(props: {
	label: string;
	value: number;
	onCommit: (n: number) => void;
}) {
	return (
		<input
			// A new key resets the field when the point is moved on the map.
			key={props.value}
			type="text"
			inputMode="numeric"
			class="coord"
			aria-label={props.label}
			defaultValue={String(props.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				e.stopPropagation();
			}}
			onBlur={(e) => {
				const n = Number(e.currentTarget.value.trim());
				if (e.currentTarget.value.trim() !== "" && Number.isInteger(n)) {
					if (n !== props.value) props.onCommit(n);
				} else e.currentTarget.value = String(props.value);
			}}
		/>
	);
}

/** Length of a line, or perimeter and area of an area, as the points stand now. */
export function ShapeStats() {
	const d = drawing.value;
	if (!d || d.type === "pin" || d.points.length < 2) return null;
	if (d.type === "line")
		return (
			<p class="shape-stats">Length: {formatBlocks(lineLength(d))} blocks</p>
		);
	const points = d.points.map(([x, z]) => ({ x, z }));
	return (
		<p class="shape-stats">
			Perimeter: {formatBlocks(pathLength(points, true))} blocks
			{points.length >= 3 && (
				<> · Area: {formatBlocks(polygonArea(points))} blocks²</>
			)}
		</p>
	);
}

/** Every point of the shape with editable coordinates, for exact placement. */
export function PointsList() {
	const d = drawing.value;
	if (!d || d.points.length === 0) return null;
	const single = d.type === "pin";
	return (
		<ul class="points-list">
			{d.points.map((p: Point, i) => (
				<li
					key={i}
					class={i === d.selected ? "selected" : undefined}
					onMouseEnter={() => {
						focusedPoint.value = i;
					}}
					onMouseLeave={() => {
						focusedPoint.value = null;
					}}
					onFocusCapture={() => {
						focusedPoint.value = i;
					}}
					onBlurCapture={() => {
						focusedPoint.value = null;
					}}
				>
					{!single && (
						<button
							type="button"
							class="point-no"
							aria-pressed={i === d.selected}
							title={
								d.type === "line"
									? "Select this point, to remove it or draw on from it"
									: "Select this point"
							}
							onClick={() => selectPoint(i === d.selected ? null : i)}
						>
							{i + 1}
						</button>
					)}
					<span class="coord-label">x</span>
					<Coordinate
						label={`x of point ${i + 1}`}
						value={p[0]}
						onCommit={(n) => setPoint(i, [n, p[1]])}
					/>
					<span class="coord-label">z</span>
					<Coordinate
						label={`z of point ${i + 1}`}
						value={p[1]}
						onCommit={(n) => setPoint(i, [p[0], n])}
					/>
					{!single && (
						<button
							type="button"
							class="btn small close"
							aria-label={`Remove point ${i + 1}`}
							title="Remove this point"
							onClick={() => removePoint(i)}
						>
							×
						</button>
					)}
				</li>
			))}
		</ul>
	);
}

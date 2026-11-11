import { useEffect, useState } from "preact/hooks";
import { attempt, type Res, type Success } from "../api";

export const number = (n: number) => n.toLocaleString();

export type Tile = { label: string; value: string; hint?: string };

export function TileGrid(props: { tiles: Tile[] }) {
	return (
		<div class="stats-grid">
			{props.tiles.map((t) => (
				<div key={t.label} class="stats-tile">
					<div class="label">{t.label}</div>
					<div class="stats-value">{t.value}</div>
					{t.hint && <div class="muted hint">{t.hint}</div>}
				</div>
			))}
		</div>
	);
}

export type SortColumn<K extends string> = {
	key: K;
	label: string;
	hint: string;
};

/** A numeric table header that sorts by its column (highest first) when clicked. */
export function SortHeader<K extends string>(props: {
	column: SortColumn<K>;
	sort: K;
	onSort: (key: K) => void;
}) {
	const { column: c } = props;
	const active = c.key === props.sort;
	return (
		<th class="stats-num" aria-sort={active ? "descending" : undefined}>
			<button
				type="button"
				class={`stats-sort ${active ? "active" : ""}`}
				title={c.hint}
				onClick={() => props.onSort(c.key)}
			>
				{c.label}
				{active ? " ▼" : ""}
			</button>
		</th>
	);
}

/** Loads statistics whenever `deps` change; the previous result stays until the next arrives. */
export function useStats<R extends Res>(
	call: () => Promise<R>,
	deps: readonly unknown[],
) {
	const [data, setData] = useState<Success<R> | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stale = false;
		void attempt(call).then((r) => {
			if (stale) return;
			if (r.ok) {
				setData(r.body);
				setError(null);
			} else setError(r.error);
		});
		return () => {
			stale = true;
		};
	}, deps);

	return { data, error };
}

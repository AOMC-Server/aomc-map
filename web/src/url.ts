import type { View } from "./map/camera";

export type UrlState = {
	map: string | null;
	dim: string | null;
	view: Partial<View>;
	rev: number | null;
	embed: boolean;
};

const num = (value: string | null): number | undefined => {
	if (value === null || value.trim() === "") return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
};

export function parseUrl(search: string): UrlState {
	const q = new URLSearchParams(search);
	const rev = num(q.get("rev"));
	return {
		map: q.get("map"),
		dim: q.get("dim"),
		view: {
			centerX: num(q.get("x")),
			centerZ: num(q.get("z")),
			zoom: num(q.get("zoom")),
		},
		rev: rev !== undefined && Number.isInteger(rev) && rev >= 0 ? rev : null,
		embed: q.get("embed") === "1",
	};
}

export function formatUrl(state: {
	map: string;
	dim: string;
	view: View;
	rev: number | null;
	embed: boolean;
}): string {
	const q = new URLSearchParams();
	q.set("map", state.map);
	q.set("dim", state.dim);
	q.set("x", String(Math.round(state.view.centerX)));
	q.set("z", String(Math.round(state.view.centerZ)));
	q.set("zoom", String(Math.round(state.view.zoom * 100) / 100));
	if (state.rev !== null) q.set("rev", String(state.rev));
	if (state.embed) q.set("embed", "1");
	return `?${q}`;
}

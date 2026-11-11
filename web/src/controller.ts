import { effect, signal } from "@preact/signals";
import { api } from "./api";
import { loadLayers } from "./layers";
import { convertView, type View } from "./map/camera";
import { MapView } from "./map/MapView";
import {
	currentMap,
	dimSlug,
	editor,
	effectiveRev,
	embed,
	isLayerHidden,
	layersData,
	loadError,
	type MapDetail,
	popup,
	rev,
	user,
	view,
	visibleDimensions,
} from "./state";
import { initTools } from "./tools";
import { stopDraw } from "./tools/draw";
import { formatUrl, parseUrl } from "./url";

/** The live map instance, for UI that needs to talk to it. */
export const mapView = signal<MapView | null>(null);

let container: HTMLElement | null = null;
let disposeTools: (() => void) | null = null;
let disposeView: (() => void) | null = null;
let selecting = 0;

export function attachContainer(el: HTMLElement | null) {
	container = el;
}

export async function loadUser() {
	const res = await api.api.me.$get();
	if (res.ok) user.value = (await res.json()).user;
}

/** There is a single map; the address bar may name it, otherwise it is the first one. */
async function mapSlugToOpen(
	fromUrl: string | null,
): Promise<string | undefined> {
	if (fromUrl) return fromUrl;
	const res = await api.api.maps.$get();
	return res.ok ? (await res.json()).maps[0]?.slug : undefined;
}

async function fetchDetail(slug: string): Promise<MapDetail | null> {
	const res = await api.api.maps[":slug"].$get({ param: { slug } });
	return res.ok ? ((await res.json()) as MapDetail) : null;
}

/** Loads a map and (re)creates the canvas for it. */
async function selectMap(
	slug: string,
	opts: { dim?: string | null; view?: Partial<View>; rev?: number | null } = {},
) {
	const ticket = ++selecting;
	const detail = await fetchDetail(slug);
	if (ticket !== selecting) return;
	if (!detail) {
		loadError.value = `Map "${slug}" was not found, or you don't have access to it.`;
		return;
	}
	loadError.value = null;

	const dims = detail.dimensions.filter((d) => !d.archived);
	const dim = dims.find((d) => d.slug === opts.dim) ?? dims[0] ?? null;

	destroyMap();
	closeFeatureUi();
	lastViews.clear();
	layersData.value = [];
	currentMap.value = detail;
	dimSlug.value = dim?.slug ?? null;
	rev.value = opts.rev !== null && opts.rev !== undefined ? opts.rev : null;

	if (!container) return;
	const mv = new MapView(container, {
		tileSize: detail.map.tileSize,
		maxZoom: detail.maxZoom,
		view: opts.view,
	});
	view.value = mv.getView();
	disposeView = mv.on("viewchange", (v) => {
		view.value = v;
	});
	disposeTools = initTools(mv);
	mapView.value = mv;
}

function closeFeatureUi() {
	stopDraw();
	editor.value = null;
	popup.value = null;
}

/** Where you last were in each dimension, for ones whose coordinates can't be converted. */
const lastViews = new Map<string, View>();

/**
 * Switches dimension and moves the camera to match. Related dimensions keep showing the same
 * place (overworld to nether divides coordinates by 8); for an unrelated one (the End) there is
 * no such place, so you land where you last were there, or at its origin the first time.
 */
export function selectDimension(slug: string) {
	if (!visibleDimensions.value.some((d) => d.slug === slug)) return;
	const detail = currentMap.value;
	const mv = mapView.value;
	const from = dimSlug.value;
	if (detail && mv && from && from !== slug) {
		const scaleOf = (s: string) =>
			detail.dimensions.find((d) => d.slug === s)?.scale ?? null;
		const here = mv.getView();
		lastViews.set(from, here);
		const converted = convertView(
			here,
			scaleOf(from),
			scaleOf(slug),
			detail.maxZoom,
		);
		mv.setView(
			converted ??
				lastViews.get(slug) ?? { centerX: 0, centerZ: 0, zoom: here.zoom },
		);
	}
	closeFeatureUi();
	dimSlug.value = slug;
}

export function setRev(value: number | null) {
	const head = currentMap.value?.map.headRev ?? 0;
	rev.value = value === null || value >= head ? null : Math.max(value, 0);
}

function destroyMap() {
	disposeTools?.();
	disposeView?.();
	mapView.value?.destroy();
	disposeTools = disposeView = null;
	mapView.value = null;
}

/** Re-reads the map so a new head revision shows up without a reload. */
/** Re-reads the map after its settings or dimensions changed. */
export async function reloadMap(): Promise<void> {
	const current = currentMap.value;
	if (!current) return;
	const detail = await fetchDetail(current.map.slug);
	if (!detail || currentMap.value !== current) return;
	currentMap.value = detail;
	// The dimension being viewed may have been archived.
	const visible = detail.dimensions.filter((d) => !d.archived);
	if (!visible.some((d) => d.slug === dimSlug.value)) {
		dimSlug.value = visible[0]?.slug ?? null;
	}
}

export async function refreshHead() {
	const current = currentMap.value;
	if (!current) return;
	const detail = await fetchDetail(current.map.slug);
	if (
		detail &&
		currentMap.value === current &&
		detail.map.headRev !== current.map.headRev
	) {
		currentMap.value = detail;
	}
}

/** Starts the app: URL state, tile source wiring, URL sync and head polling. */
export async function boot() {
	const initial = parseUrl(location.search);
	embed.value = initial.embed;
	const [slug] = await Promise.all([mapSlugToOpen(initial.map), loadUser()]);
	if (!slug) {
		loadError.value = "No maps are available.";
		return;
	}
	await selectMap(slug, {
		dim: initial.dim,
		view: initial.view,
		rev: initial.rev,
	});

	let lastKey = "";
	effect(() => {
		const mv = mapView.value;
		const detail = currentMap.value;
		const dim = dimSlug.value;
		const r = effectiveRev.value;
		if (!mv || !detail || !dim) return;
		const base = `/api/maps/${detail.map.slug}/dimensions/${dim}/tiles`;
		const key = `${detail.map.slug}/${dim}`;
		mv.setTileSource((z, x, y) => `${base}/${z}/${x}/${y}?rev=${r}`, {
			keepPrevious: key === lastKey,
		});
		lastKey = key;
	});

	// Reload layers whenever what we are looking at (map, dimension, time) changes.
	// Debounced so dragging the time slider does not fire a request per step.
	let layersTimer: ReturnType<typeof setTimeout> | undefined;
	effect(() => {
		currentMap.value;
		dimSlug.value;
		rev.value;
		clearTimeout(layersTimer);
		layersTimer = setTimeout(() => void loadLayers(), 120);
	});

	// Draw the layers the user has switched on.
	effect(() => {
		const mv = mapView.value;
		if (!mv) return;
		mv.setFeatures(
			layersData.value
				.filter((l) => !isLayerHidden(l))
				.map((l) => ({ id: l.id, color: l.color, features: l.features })),
		);
	});

	let urlTimer: ReturnType<typeof setTimeout> | undefined;
	effect(() => {
		const detail = currentMap.value;
		const dim = dimSlug.value;
		const state = {
			map: detail?.map.slug ?? "",
			dim: dim ?? "",
			view: view.value,
			rev: rev.value,
			embed: embed.value,
		};
		clearTimeout(urlTimer);
		urlTimer = setTimeout(() => {
			if (state.map && state.dim)
				history.replaceState(null, "", formatUrl(state));
		}, 200);
	});

	setInterval(refreshHead, 30_000);
}

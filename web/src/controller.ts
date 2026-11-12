import { convertView, type View } from "@aomc/shared/view";
import { effect, signal } from "@preact/signals";
import type { InferResponseType } from "hono/client";
import { api, showNotice } from "./api";
import { subscribe } from "./events";
import { loadLayers } from "./layers";
import { MapView } from "./map/MapView";
import type { TileLookup } from "./map/tileLayer";
import {
	loadPosition,
	savePosition,
	settings,
	transitionFactor,
} from "./settings";
import {
	contextMenu,
	currentMap,
	dimSlug,
	editor,
	effectiveRev,
	embed,
	isLayerHidden,
	isolatedUpload,
	layersData,
	loadError,
	mapEpoch,
	popup,
	preloadProgress,
	type RevisionInfo,
	rev,
	sharedLayers,
	tilesPaused,
	user,
	view,
	visibleDimensions,
} from "./state";
import { initTools } from "./tools";
import { stopDraw } from "./tools/draw";
import { formatUrl, parseUrl } from "./url";

/** The response of the tile hash lookup, typed from the server's route (the query is not typed there). */
type TileHashes = InferResponseType<
	(typeof api.api.dimensions)[":dim"]["tiles"][":zoom"]["hashes"]["$get"],
	200
>;

/** The live map instance, for UI that needs to talk to it. */
export const mapView = signal<MapView | null>(null);

/** Loads who is logged in. False if the server could not be asked. */
export async function loadUser(): Promise<boolean> {
	try {
		const res = await api.api.me.$get();
		if (res.ok) user.value = (await res.json()).user;
		return res.ok;
	} catch {
		return false;
	}
}

async function fetchMap() {
	try {
		const res = await api.api.map.$get();
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

/** For pages without the map: loads the map details (name, dimensions, your role). */
export async function loadMapDetail(): Promise<boolean> {
	const detail = await fetchMap();
	if (detail) currentMap.value = detail;
	return detail !== null;
}

/** What the standalone pages need: the map details and the user. False if either failed. */
export async function loadPageData(): Promise<boolean> {
	const [mapLoaded, userLoaded] = await Promise.all([
		loadMapDetail(),
		loadUser(),
	]);
	return mapLoaded && userLoaded;
}

function closeFeatureUi() {
	contextMenu.value = null;
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
	// An upload is only shown alone in its own dimension.
	isolatedUpload.value = null;
	// The layers of a shared link belong to its dimension.
	if (slug !== from) sharedLayers.value = null;
	dimSlug.value = slug;
}

/** Shows one upload's tiles on their own, zoomed to where it reached unless `fit` is false. */
export function isolateUpload(r: RevisionInfo, fit = true) {
	const slug = currentMap.value?.dimensions.find(
		(d) => d.id === r.dimensionId,
	)?.slug;
	if (!slug || !visibleDimensions.value.some((d) => d.slug === slug)) {
		showNotice("That upload's dimension is archived.", "error");
		return;
	}
	selectDimension(slug);
	setRev(null);
	isolatedUpload.value = r;
	if (fit && r.bbox)
		mapView.value?.fitBounds(r.bbox, { padding: 120, closestZoom: 0 });
}

/** Views a revision; the head (or anything newer) means "latest". */
export function setRev(value: number | null) {
	// Looking at a point in time means looking at the whole map again.
	if (value !== null) isolatedUpload.value = null;
	const head = currentMap.value?.map.headRev ?? 0;
	rev.value = value === null || value >= head ? null : Math.max(value, 0);
}

/** An upload shown on its own is erased when it is deleted; stop showing it then. */
async function dropIsolatedIfGone() {
	const shown = isolatedUpload.value;
	if (!shown) return;
	try {
		const res = await api.api.revisions[":id"].$get({
			param: { id: String(shown.id) },
		});
		if (res.status === 404 && isolatedUpload.value?.id === shown.id)
			isolatedUpload.value = null;
	} catch {}
}

/**
 * Re-reads the map so a new head revision, renamed or archived dimensions and the like show up
 * without a reload. The signal is only assigned when something changed, since that restarts
 * the tile and layer loads.
 */
export async function refreshMap(): Promise<void> {
	const current = currentMap.value;
	const detail = await fetchMap();
	if (!current || !detail || currentMap.value !== current) return;
	if (JSON.stringify(detail) === JSON.stringify(current)) return;
	currentMap.value = detail;
	if (detail.map.epoch !== current.map.epoch) void dropIsolatedIfGone();
	// The dimension being viewed may have been archived.
	const visible = visibleDimensions.value;
	if (!visible.some((d) => d.slug === dimSlug.value)) {
		sharedLayers.value = null;
		dimSlug.value = visible[0]?.slug ?? null;
	}
}

/** Starts the app: loads the map, builds the canvas, and wires URL sync and head polling. */
export async function boot(container: HTMLElement) {
	const initial = parseUrl(location.search);
	embed.value = initial.embed;
	const [detail] = await Promise.all([fetchMap(), loadUser()]);
	if (!detail) {
		loadError.value =
			"The map could not be loaded. Check your connection and try again.";
		return;
	}
	currentMap.value = detail;
	const dims = visibleDimensions.value;

	// The URL wins; without a place in it, fall back to where you were, then to your default.
	const urlNamesPlace =
		initial.dim !== null ||
		initial.view.centerX !== undefined ||
		initial.view.centerZ !== undefined;
	const saved =
		settings.value.rememberPosition && !initial.embed && !urlNamesPlace
			? loadPosition()
			: null;
	const startDim =
		[initial.dim, saved?.dim, settings.value.defaultDimension]
			.map((slug) => dims.find((d) => d.slug === slug)?.slug)
			.find((slug) => slug !== undefined) ??
		dims[0]?.slug ??
		null;
	dimSlug.value = startDim;
	if (initial.layers && startDim === initial.dim)
		sharedLayers.value = new Set(initial.layers);
	const startView = saved && saved.dim === startDim ? saved.view : initial.view;
	setRev(initial.rev);

	const mv = new MapView(container, {
		tileSize: detail.map.tileSize,
		maxZoom: detail.maxZoom,
		view: startView,
	});
	view.value = mv.getView();
	mv.on("viewchange", (v) => {
		view.value = v;
	});
	mv.on("preloadprogress", (p) => {
		preloadProgress.value = p;
	});
	initTools(mv);
	mapView.value = mv;
	effect(() =>
		mv.setMotionScale(transitionFactor(settings.value.transitionSpeed)),
	);
	effect(() => {
		const { debugRender, tileOutlines, chunkOutlines } = settings.value;
		mv.setDebug({ debug: debugRender, tileOutlines, chunkOutlines });
		mv.setTilesPaused(debugRender && tilesPaused.value);
	});

	let lastDim: string | null = null;
	let lastOnly: number | null = null;
	effect(() => {
		const dim = dimSlug.value;
		const r = effectiveRev.value;
		const only = isolatedUpload.value?.id ?? null;
		const epoch = mapEpoch.value;
		if (!dim) return;
		const query =
			only === null ? `rev=${r}&v=${epoch}` : `only=${only}&v=${epoch}`;
		// Isolated uploads are drawn on the fly and have no hashes to look up.
		const lookup: TileLookup | undefined =
			only === null
				? async (z, rect, signal) => {
						const area = `minX=${rect.minX}&minY=${rect.minY}&maxX=${rect.maxX}&maxY=${rect.maxY}`;
						const res = await fetch(
							`/api/dimensions/${dim}/tiles/${z}/hashes?${area}&${query}`,
							{ signal },
						);
						if (!res.ok) throw new Error(`tile lookup ${res.status}`);
						const body = (await res.json()) as TileHashes;
						return new Map(
							body.tiles.map((t) => [`${t.x}/${t.y}`, `/blobs/${t.hash}.webp`]),
						);
					}
				: undefined;
		// Keep the old tiles up while new ones load, except when switching what is shown.
		mv.setTileSource(
			(z, x, y) => `/api/dimensions/${dim}/tiles/${z}/${x}/${y}?${query}`,
			dim === lastDim && only === lastOnly,
			lookup,
		);
		lastDim = dim;
		lastOnly = only;
	});
	effect(() => {
		const dim = currentMap.value?.dimensions.find(
			(d) => d.slug === dimSlug.value,
		);
		mv.setPreload(settings.value.preloadSpawn ? (dim?.preload ?? []) : []);
	});

	// Reload layers whenever what we are looking at (head, dimension, time) changes.
	// Debounced so dragging the time slider does not fire a request per step.
	let layersTimer: ReturnType<typeof setTimeout> | undefined;
	let layersDim: string | null = null;
	effect(() => {
		currentMap.value?.map.headRev;
		// What you may edit changes with maintenance.
		currentMap.value?.map.maintenance;
		const dim = dimSlug.value;
		rev.value;
		clearTimeout(layersTimer);
		// Another dimension's overlays do not belong on this map: drop them and load at once.
		// Within a dimension the old ones stay up until the new ones arrive.
		if (dim !== layersDim) {
			layersDim = dim;
			layersData.value = [];
			void loadLayers();
			return;
		}
		layersTimer = setTimeout(() => void loadLayers(), 120);
	});

	// Draw the layers the user has switched on.
	effect(() => {
		mv.setFeatures(
			layersData.value
				.filter((l) => !isLayerHidden(l))
				.map((l) => ({ id: l.id, color: l.color, features: l.features })),
		);
	});

	let urlTimer: ReturnType<typeof setTimeout> | undefined;
	effect(() => {
		const state = {
			dim: dimSlug.value ?? "",
			view: view.value,
			rev: rev.value,
			embed: embed.value,
		};
		clearTimeout(urlTimer);
		urlTimer = setTimeout(() => {
			if (!state.dim) return;
			history.replaceState(null, "", formatUrl(state));
			if (settings.value.rememberPosition && !state.embed) {
				savePosition({ dim: state.dim, view: state.view });
			}
		}, 200);
	});

	// The server announces map changes; polling is only the fallback while the stream is down.
	subscribe("map", {
		onEvent: (m, { snapshot }) => {
			const current = currentMap.value?.map;
			const same =
				current?.headRev === m.headRev &&
				current.epoch === m.epoch &&
				current.maintenance === m.maintenance;
			if (snapshot && same) return;
			void refreshMap();
		},
		poll: () => void refreshMap(),
		pollMs: 30_000,
	});

	followLayers();
}

/**
 * Reloads the layers when someone else changes those of the dimension being viewed. A feature
 * being edited keeps its draft in the editor itself, so a reload would not lose it, but the
 * feature or layer under it could vanish or move; so while the editor is open the reload waits
 * until it closes.
 */
function followLayers() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stale = false;
	const reload = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (editor.peek() !== null) stale = true;
			else void loadLayers();
		}, 300);
	};
	effect(() => {
		if (editor.value === null && stale) {
			stale = false;
			reload();
		}
	});

	let followed: number | null = null;
	let unsubscribe: (() => void) | undefined;
	effect(() => {
		const id =
			currentMap.value?.dimensions.find((d) => d.slug === dimSlug.value)?.id ??
			null;
		if (id === followed) return;
		followed = id;
		unsubscribe?.();
		unsubscribe = undefined;
		stale = false;
		clearTimeout(timer);
		if (id === null) return;
		// Layers are loaded when the dimension changes; the first delivery is only their state.
		let first = true;
		unsubscribe = subscribe(`layers:${id}`, {
			onEvent: () => {
				if (first) first = false;
				else reload();
			},
		});
	});
}

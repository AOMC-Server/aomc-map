import type {
	CreateLayer,
	FeatureInput,
	UpdateLayer,
} from "@aomc/shared/features";
import { api } from "./api";
import {
	currentMap,
	dimSlug,
	type FeatureData,
	type LayerData,
	layersData,
	notice,
	rev,
} from "./state";

/** Reads the error message of a failed API response. */
async function failure(res: Res): Promise<string> {
	try {
		const body = (await res.json()) as { error?: string };
		return body.error ?? `Request failed (${res.status})`;
	} catch {
		return `Request failed (${res.status})`;
	}
}

export function showNotice(text: string, kind: "error" | "info" = "info") {
	notice.value = { text, kind };
	setTimeout(() => {
		if (notice.value?.text === text) notice.value = null;
	}, 5000);
}

/** What we need from a response; the typed client's responses satisfy this. */
type Res = { ok: boolean; status: number; json(): Promise<unknown> };

/** Runs an API call, reporting failures to the user. Returns the parsed body, or null on failure. */
export async function run<T>(call: () => Promise<Res>): Promise<T | null> {
	try {
		const res = await call();
		if (!res.ok) {
			showNotice(await failure(res), "error");
			return null;
		}
		return (await res.json()) as T;
	} catch (err) {
		showNotice(err instanceof Error ? err.message : "Network error", "error");
		return null;
	}
}

/** Loads the layers of the current map and dimension, as of the current revision. */
export async function loadLayers(): Promise<void> {
	const detail = currentMap.value;
	const dim = dimSlug.value;
	if (!detail || !dim) {
		layersData.value = [];
		return;
	}
	const at = rev.value;
	const res = await api.api.maps[":slug"].layers.$get({
		param: { slug: detail.map.slug },
		query: { dim, ...(at === null ? {} : { at: String(at) }) },
	});
	// A newer load may have been started while this one was in flight.
	if (currentMap.value !== detail || dimSlug.value !== dim || rev.value !== at)
		return;
	if (res.ok)
		layersData.value = ((await res.json()) as { layers: LayerData[] }).layers;
}

export async function createLayer(input: Omit<CreateLayer, "dimension">) {
	const slug = currentMap.value?.map.slug;
	const dimension = dimSlug.value;
	if (!slug || !dimension) return null;
	const out = await run<{ layer: LayerData }>(() =>
		api.api.maps[":slug"].layers.$post({
			param: { slug },
			json: { ...input, dimension },
		}),
	);
	if (out) await loadLayers();
	return out?.layer ?? null;
}

export async function updateLayer(id: number, patch: UpdateLayer) {
	const out = await run(() =>
		api.api.layers[":id"].$patch({ param: { id: String(id) }, json: patch }),
	);
	if (out) await loadLayers();
	return out !== null;
}

export async function deleteLayer(id: number) {
	const out = await run(() =>
		api.api.layers[":id"].$delete({ param: { id: String(id) } }),
	);
	if (out) await loadLayers();
	return out !== null;
}

export async function createFeature(layerId: number, input: FeatureInput) {
	const out = await run<{ feature: FeatureData }>(() =>
		api.api.layers[":id"].features.$post({
			param: { id: String(layerId) },
			json: input,
		}),
	);
	if (out) await loadLayers();
	return out?.feature ?? null;
}

export async function updateFeature(id: number, patch: Partial<FeatureInput>) {
	const out = await run<{ feature: FeatureData }>(() =>
		api.api.features[":id"].$patch({ param: { id: String(id) }, json: patch }),
	);
	if (out) await loadLayers();
	return out?.feature ?? null;
}

export async function deleteFeature(id: number) {
	const out = await run(() =>
		api.api.features[":id"].$delete({ param: { id: String(id) } }),
	);
	if (out) await loadLayers();
	return out !== null;
}

export async function importFeatures(
	layerId: number,
	items: unknown,
	replace: boolean,
) {
	const out = await run<{ imported: number; replaced: number }>(() =>
		api.api.layers[":id"].import.$post({
			param: { id: String(layerId) },
			query: replace ? { replace: "1" } : {},
			json: items as FeatureInput[],
		}),
	);
	if (out) await loadLayers();
	return out;
}

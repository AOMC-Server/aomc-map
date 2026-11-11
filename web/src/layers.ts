import type {
	CreateLayer,
	FeatureInput,
	UpdateLayer,
} from "@aomc/shared/features";
import { api, ok, type Res, run } from "./api";
import { dimSlug, layersData, rev } from "./state";

/** Loads the layers of the current dimension, as of the current revision. */
export async function loadLayers(): Promise<void> {
	const dim = dimSlug.value;
	if (!dim) {
		layersData.value = [];
		return;
	}
	const at = rev.value;
	const res = await api.api.layers.$get({
		query: { dim, ...(at === null ? {} : { at: String(at) }) },
	});
	// A newer load may have been started while this one was in flight.
	if (dimSlug.value !== dim || rev.value !== at) return;
	if (res.ok)
		layersData.value = (await res.json()).layers as typeof layersData.value;
}

export const mutate = <R extends Res>(call: () => Promise<R>) =>
	run(call, loadLayers);
export const mutateOk = (call: () => Promise<Res>) => ok(call, loadLayers);

export async function createLayer(input: Omit<CreateLayer, "dimension">) {
	const dimension = dimSlug.value;
	if (!dimension) return null;
	const out = await mutate(() =>
		api.api.layers.$post({ json: { ...input, dimension } }),
	);
	return out?.layer ?? null;
}

export function updateLayer(id: number, patch: UpdateLayer) {
	return mutateOk(() =>
		api.api.layers[":id"].$patch({ param: { id: String(id) }, json: patch }),
	);
}

export function deleteLayer(id: number) {
	return mutateOk(() =>
		api.api.layers[":id"].$delete({ param: { id: String(id) } }),
	);
}

export async function createFeature(layerId: number, input: FeatureInput) {
	const out = await mutate(() =>
		api.api.layers[":id"].features.$post({
			param: { id: String(layerId) },
			json: input,
		}),
	);
	return out?.feature ?? null;
}

export async function updateFeature(id: number, patch: Partial<FeatureInput>) {
	const out = await mutate(() =>
		api.api.features[":id"].$patch({ param: { id: String(id) }, json: patch }),
	);
	return out?.feature ?? null;
}

export function deleteFeature(id: number) {
	return mutateOk(() =>
		api.api.features[":id"].$delete({ param: { id: String(id) } }),
	);
}

export function importFeatures(
	layerId: number,
	items: FeatureInput[],
	replace: boolean,
) {
	return mutate(() =>
		api.api.layers[":id"].import.$post({
			param: { id: String(layerId) },
			query: replace ? { replace: "1" } : {},
			json: items,
		}),
	);
}

/** Moves the layers of the dimension into the given order. The list shows it at once; a failure restores the real order. */
export async function reorderLayers(ids: number[]) {
	const dimension = dimSlug.value;
	if (!dimension) return;
	const byId = new Map(layersData.value.map((l) => [l.id, l]));
	layersData.value = ids.flatMap((id) => byId.get(id) ?? []);
	const out = await run(() =>
		api.api.layers.reorder.$post({ json: { dimension, ids } }),
	);
	if (!out) await loadLayers();
}

/** Moves the features of a layer into the given order, like `reorderLayers`. */
export async function reorderFeatures(layerId: number, ids: number[]) {
	layersData.value = layersData.value.map((l) => {
		if (l.id !== layerId) return l;
		const byId = new Map(l.features.map((f) => [f.id, f]));
		return { ...l, features: ids.flatMap((id) => byId.get(id) ?? []) };
	});
	const out = await run(() =>
		api.api.layers[":id"].features.reorder.$post({
			param: { id: String(layerId) },
			json: { ids },
		}),
	);
	if (!out) await loadLayers();
}

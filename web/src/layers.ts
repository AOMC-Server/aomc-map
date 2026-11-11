import type {
	CreateLayer,
	FeatureInput,
	UpdateLayer,
} from "@aomc/shared/features";
import { api, attempt, ok, type Res, run, showNotice } from "./api";
import { dimSlug, layersData, rev } from "./state";

let loadSeq = 0;

/** Loads the layers of the current dimension, as of the current revision. */
export async function loadLayers(): Promise<void> {
	const dim = dimSlug.value;
	if (!dim) {
		loadSeq++;
		layersData.value = [];
		return;
	}
	const at = rev.value;
	const seq = ++loadSeq;
	const result = await attempt(() =>
		api.api.layers.$get({
			query: { dim, ...(at === null ? {} : { at: String(at) }) },
		}),
	);
	// A newer load may have been started while this one was in flight; the last one wins.
	if (seq !== loadSeq) return;
	if (result.ok)
		layersData.value = result.body.layers as typeof layersData.value;
	else showNotice(`Could not load the layers: ${result.error}`, "error");
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

export type FeatureUpdate =
	| { saved: true }
	| { saved: false; conflict: { revisionId: number } | null };

/**
 * Saves changes to a feature made on top of `baseRevisionId`. If someone changed it meanwhile
 * the layers are reloaded and the revision that is current now is returned, so the caller can
 * keep what the user typed and let them save again on top of it.
 */
export async function updateFeature(
	id: number,
	patch: Partial<FeatureInput>,
	baseRevisionId: number | undefined,
): Promise<FeatureUpdate> {
	const res = await attempt(() =>
		api.api.features[":id"].$patch({
			param: { id: String(id) },
			json: { ...patch, baseRevisionId },
		}),
	);
	if (res.ok) {
		await loadLayers();
		return { saved: true };
	}
	if (res.status === 409) {
		await loadLayers();
		const current = (res.detail as { feature?: { revisionId?: number } } | null)
			?.feature?.revisionId;
		showNotice(
			"Someone else changed this feature while you were editing. Their version is on the map now; save again to replace it with yours.",
			"error",
		);
		return {
			saved: false,
			conflict: current === undefined ? null : { revisionId: current },
		};
	}
	showNotice(res.error, "error");
	return { saved: false, conflict: null };
}

/** Deletes a feature; if the server refuses because it changed, the layers are reloaded to show the current state. */
export async function deleteFeature(id: number) {
	const res = await attempt(() =>
		api.api.features[":id"].$delete({ param: { id: String(id) } }),
	);
	if (res.ok) {
		await loadLayers();
		return true;
	}
	showNotice(res.error, "error");
	if (res.status === 409 || res.status === 404) await loadLayers();
	return false;
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

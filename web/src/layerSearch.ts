import { TYPE_LABEL } from "./featureInfo";
import type { FeatureData, LayerData } from "./state";

const normalize = (s: string) => s.trim().toLowerCase();

/** A feature matches when the query is in its name, its popup text or its type (pin, line, area). */
export function featureMatches(
	f: Pick<FeatureData, "name" | "popup" | "type">,
	query: string,
): boolean {
	const q = normalize(query);
	if (!q) return true;
	return [f.name, f.popup, TYPE_LABEL[f.type]].some((text) =>
		text.toLowerCase().includes(q),
	);
}

export type LayerMatch = { layer: LayerData; features: FeatureData[] };

/**
 * The layers that have something to show for the query, each with the features to list. A layer
 * whose own name matches is listed whole; otherwise only its matching features are.
 */
export function searchLayers(layers: LayerData[], query: string): LayerMatch[] {
	const q = normalize(query);
	if (!q) return layers.map((layer) => ({ layer, features: layer.features }));
	const out: LayerMatch[] = [];
	for (const layer of layers) {
		if (layer.name.toLowerCase().includes(q)) {
			out.push({ layer, features: layer.features });
			continue;
		}
		const features = layer.features.filter((f) => featureMatches(f, q));
		if (features.length > 0) out.push({ layer, features });
	}
	return out;
}

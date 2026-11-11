import type { Dye } from "@aomc/shared/colors";
import type { FeatureType, Point } from "@aomc/shared/features";
import type { DimensionTheme } from "@aomc/shared/schemas";
import type { View } from "@aomc/shared/view";
import { computed, signal } from "@preact/signals";
import type { InferResponseType } from "hono/client";
import type { api } from "./api";

export type User = { id: string; username: string; avatarUrl: string | null };

export type MapDetail = InferResponseType<typeof api.api.map.$get, 200>;
export type Dimension = MapDetail["dimensions"][number];
export type UploadLimits = MapDetail["limits"];

export type FeatureData = {
	id: number;
	layerId: number;
	revisionId: number;
	type: FeatureType;
	name: string;
	popup: string;
	color: Dye | null;
	geometry: Point | Point[];
	authorId: string;
	updatedAt: number;
};

export type LayerData = Omit<
	InferResponseType<typeof api.api.layers.$get, 200>["layers"][number],
	"features" | "color"
> & { color: Dye; features: FeatureData[] };

export type SidePanelName = "layers" | "history";

export type Tool = "none" | "measure";

export const user = signal<User | null>(null);
export const currentMap = signal<MapDetail | null>(null);
export const dimSlug = signal<string | null>(null);
/** null means "follow head". */
export const rev = signal<number | null>(null);
export const embed = signal(false);
export const view = signal<View>({ centerX: 0, centerZ: 0, zoom: 2 });
export const cursor = signal<{ x: number; z: number } | null>(null);
export const activeTool = signal<Tool>("none");
export const loadError = signal<string | null>(null);

export const notice = signal<{ text: string; kind: "error" | "info" } | null>(
	null,
);

export const layersData = signal<LayerData[]>([]);
/** Layers the user toggled away from their default (layerId -> hidden). */
const layerOverrides = signal<Map<number, boolean>>(new Map());
export const sidePanel = signal<SidePanelName | null>(null);

export type RevisionInfo = InferResponseType<
	typeof api.api.revisions.$get,
	200
>["revisions"][number];

/** Changes when history is rewritten (an upload is deleted), so cached tiles are not reused. */
export const mapEpoch = computed(() => currentMap.value?.map.epoch ?? 0);

/** The upload being looked at on its own (tiles of that upload only), or null for the whole map. */
export const isolatedUpload = signal<RevisionInfo | null>(null);

/** Revisions of the dimension being viewed, newest first. */
export const revisionsData = signal<RevisionInfo[]>([]);
/** Area of a revision to outline on the map (hovered or selected in the upload log). */
export const highlightBbox = signal<RevisionInfo["bbox"]>(null);
/** The upload pointed at in the history panel, and where: the other side highlights it too. */
export const hoveredRevision = signal<{
	id: number;
	from: "timeline" | "log";
} | null>(null);

export const isLayerHidden = (l: LayerData) =>
	layerOverrides.value.get(l.id) ?? l.hiddenByDefault;

export function toggleLayer(l: LayerData) {
	const next = new Map(layerOverrides.value);
	next.set(l.id, !isLayerHidden(l));
	layerOverrides.value = next;
}

/** Shows or hides the given layers, overriding their defaults. */
export function setLayersHidden(layers: LayerData[], hidden: boolean) {
	const next = new Map(layerOverrides.value);
	for (const l of layers) next.set(l.id, hidden);
	layerOverrides.value = next;
}

/** Shows `only` and hides every other layer of the dimension. */
export function showOnlyLayer(only: LayerData) {
	const next = new Map(layerOverrides.value);
	for (const l of layersData.value) next.set(l.id, l.id !== only.id);
	layerOverrides.value = next;
}

/** The clicked feature whose popup is open, with the block position the popup is anchored to. */
export const popup = signal<{
	featureId: number;
	layerId: number;
	x: number;
	z: number;
} | null>(null);
export const hoverInfo = signal<{
	text: string;
	sx: number;
	sy: number;
} | null>(null);

export type EditorTarget =
	| { mode: "create"; layerId: number }
	| { mode: "edit"; layerId: number; featureId: number };
export const editor = signal<EditorTarget | null>(null);

/** Edits are only possible while looking at the present. */
const viewingHistory = computed(() => rev.value !== null);
export const canEditMap = computed(() => {
	const role = currentMap.value?.role;
	return !viewingHistory.value && role !== undefined && role !== "viewer";
});

export const isModerator = computed(() => {
	const role = currentMap.value?.role;
	return role === "moderator" || role === "owner";
});

export const effectiveRev = computed(() => {
	const head = currentMap.value?.map.headRev ?? 0;
	return Math.min(rev.value ?? head, head);
});

/** Scale of the dimension being viewed (overworld blocks per block), or null if unrelated. */
export const currentScale = computed(
	() =>
		currentMap.value?.dimensions.find((d) => d.slug === dimSlug.value)?.scale ??
		null,
);

/** Theme of the dimension being viewed, which colours the interface. */
export const currentDimensionTheme = computed<DimensionTheme>(
	() =>
		currentMap.value?.dimensions.find((d) => d.slug === dimSlug.value)?.theme ??
		"overworld",
);

export const visibleDimensions = computed(
	() => currentMap.value?.dimensions.filter((d) => !d.archived) ?? [],
);

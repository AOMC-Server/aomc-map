import type { Dye } from "@aomc/shared/colors";
import type { FeatureType, Point } from "@aomc/shared/features";
import type { Role } from "@aomc/shared/schemas";
import { computed, signal } from "@preact/signals";
import type { View } from "./map/camera";

export type User = { id: string; username: string; avatarUrl: string | null };

export type MapSummary = {
	id: number;
	slug: string;
	name: string;
	visibility: "public" | "private";
	isDefault: boolean;
	tileSize: number;
	headRev: number;
};

export type Dimension = {
	id: number;
	slug: string;
	name: string;
	sortOrder: number;
	archived: boolean;
};

export type UploadLimits = {
	maxUploadBytes: number;
	maxFilesPerUpload: number;
	maxImageDim: number;
};

export type MapDetail = {
	map: MapSummary;
	role: Role;
	maxZoom: number;
	limits: UploadLimits;
	dimensions: Dimension[];
};

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

export type LayerData = {
	id: number;
	dimensionId: number;
	name: string;
	color: Dye;
	hiddenByDefault: boolean;
	visibility: "inherit" | "private";
	sortOrder: number;
	createdBy: string;
	canEdit: boolean;
	/** May manage who can see and edit this layer (members, invite links). */
	canManage: boolean;
	features: FeatureData[];
};

export type Tool = "none" | "measure" | "copy";

export const user = signal<User | null>(null);
export const maps = signal<MapSummary[]>([]);
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
export const layerOverrides = signal<Map<number, boolean>>(new Map());
export const layerPanelOpen = signal(false);
export const historyPanelOpen = signal(false);
export const mapPanelOpen = signal(false);

export type SidePanelName = "layers" | "history" | "map";

/** One side panel at a time; opening the one that is already open closes it. */
export function toggleSidePanel(name: SidePanelName) {
	const was = {
		layers: layerPanelOpen,
		history: historyPanelOpen,
		map: mapPanelOpen,
	}[name].value;
	layerPanelOpen.value = false;
	historyPanelOpen.value = false;
	mapPanelOpen.value = false;
	if (!was) {
		({ layers: layerPanelOpen, history: historyPanelOpen, map: mapPanelOpen })[
			name
		].value = true;
	}
}

export type RevisionInfo = {
	id: number;
	rev: number | null;
	kind: "upload" | "revert" | "unrevert";
	dimensionId: number | null;
	authorId: string;
	authorName: string;
	targetRevisionId: number | null;
	status: "pending" | "processing" | "done" | "failed";
	error: string | null;
	bbox: { minX: number; minZ: number; maxX: number; maxZ: number } | null;
	fileCount: number;
	reverted: boolean;
	createdAt: number;
	completedAt: number | null;
};

/** Revisions of the current map, newest first. */
export const revisionsData = signal<RevisionInfo[]>([]);
/** Area of a revision to outline on the map (hovered or selected in the upload log). */
export const highlightBbox = signal<RevisionInfo["bbox"]>(null);

export const isLayerHidden = (l: LayerData) =>
	layerOverrides.value.get(l.id) ?? l.hiddenByDefault;

export function toggleLayer(l: LayerData) {
	const next = new Map(layerOverrides.value);
	next.set(l.id, !isLayerHidden(l));
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
export const viewingHistory = computed(() => rev.value !== null);
export const canEditMap = computed(() => {
	const role = currentMap.value?.role;
	return (
		!viewingHistory.value &&
		user.value !== null &&
		role !== undefined &&
		role !== "viewer"
	);
});

export const isModerator = computed(() => {
	const role = currentMap.value?.role;
	return user.value !== null && (role === "moderator" || role === "owner");
});

/** Owners manage everything; moderators of the main map manage its dimensions. */
export const canAdminister = computed(() => {
	const d = currentMap.value;
	return (
		user.value !== null &&
		d !== null &&
		(d.role === "owner" || (d.role === "moderator" && d.map.isDefault))
	);
});

export const effectiveRev = computed(() => {
	const head = currentMap.value?.map.headRev ?? 0;
	return Math.min(rev.value ?? head, head);
});

export const visibleDimensions = computed(
	() => currentMap.value?.dimensions.filter((d) => !d.archived) ?? [],
);

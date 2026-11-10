import type { Role } from "@aomc/shared";
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

export type MapDetail = {
	map: MapSummary;
	role: Role;
	maxZoom: number;
	dimensions: Dimension[];
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

export const effectiveRev = computed(() => {
	const head = currentMap.value?.map.headRev ?? 0;
	return Math.min(rev.value ?? head, head);
});

export const visibleDimensions = computed(
	() => currentMap.value?.dimensions.filter((d) => !d.archived) ?? [],
);

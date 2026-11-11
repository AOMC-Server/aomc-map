import type { Role } from "@aomc/shared/schemas";
import type { CreateLayerInvite, CreateMapInvite } from "@aomc/shared/sharing";
import { api } from "./api";
import { reloadMap } from "./controller";
import { loadLayers, run } from "./layers";
import { currentMap } from "./state";

export type Member<R extends string = Role> = {
	userId: string;
	role: R;
	username: string;
	avatarUrl: string | null;
};

export type InviteInfo = {
	id: number;
	kind: "map" | "layer";
	role: string;
	createdByName: string;
	expiresAt: number | null;
	maxUses: number | null;
	uses: number;
	status: "active" | "revoked" | "expired" | "exhausted";
};

export type CreatedInvite = { invite: InviteInfo; token: string; url: string };

const slug = () => currentMap.value?.map.slug ?? "";
const idParam = (id: number) => ({ id: String(id) });

// Map members

export async function loadMapMembers(): Promise<Member[] | null> {
	const out = await run<{ members: Member[] }>(() =>
		api.api.maps[":slug"].members.$get({ param: { slug: slug() } }),
	);
	return out?.members ?? null;
}

export async function addMapMember(userId: string, role: Role) {
	return (
		(await run(() =>
			api.api.maps[":slug"].members.$post({
				param: { slug: slug() },
				json: { userId, role },
			}),
		)) !== null
	);
}

export async function setMapMemberRole(userId: string, role: Role) {
	return (
		(await run(() =>
			api.api.maps[":slug"].members[":userId"].$patch({
				param: { slug: slug(), userId },
				json: { role },
			}),
		)) !== null
	);
}

export async function removeMapMember(userId: string) {
	return (
		(await run(() =>
			api.api.maps[":slug"].members[":userId"].$delete({
				param: { slug: slug(), userId },
			}),
		)) !== null
	);
}

// Map invites

export async function loadMapInvites(): Promise<InviteInfo[] | null> {
	const out = await run<{ invites: InviteInfo[] }>(() =>
		api.api.maps[":slug"].invites.$get({ param: { slug: slug() } }),
	);
	return out?.invites ?? null;
}

export function createMapInvite(input: CreateMapInvite) {
	return run<CreatedInvite>(() =>
		api.api.maps[":slug"].invites.$post({
			param: { slug: slug() },
			json: input,
		}),
	);
}

export async function revokeInvite(id: number) {
	return (
		(await run(() =>
			api.api.invites[":id"].$delete({ param: idParam(id) }),
		)) !== null
	);
}

// Map settings and dimensions

export async function updateMapSettings(patch: {
	name?: string;
	tileSize?: number;
}) {
	const out = await run(() =>
		api.api.maps[":slug"].$patch({ param: { slug: slug() }, json: patch }),
	);
	if (out) await reloadMap();
	return out !== null;
}

export async function addDimension(dimSlug: string, name: string) {
	const out = await run(() =>
		api.api.maps[":slug"].dimensions.$post({
			param: { slug: slug() },
			json: { slug: dimSlug, name },
		}),
	);
	if (out) await reloadMap();
	return out !== null;
}

export async function updateDimension(
	dimSlug: string,
	patch: { name?: string; sortOrder?: number; archived?: boolean },
) {
	const out = await run(() =>
		api.api.maps[":slug"].dimensions[":dim"].$patch({
			param: { slug: slug(), dim: dimSlug },
			json: patch,
		}),
	);
	if (out) await reloadMap();
	return out !== null;
}

// Layer members and invites

export type LayerRoleName = "viewer" | "editor";

export async function loadLayerMembers(
	layerId: number,
): Promise<Member<LayerRoleName>[] | null> {
	const out = await run<{ members: Member<LayerRoleName>[] }>(() =>
		api.api.layers[":id"].members.$get({ param: idParam(layerId) }),
	);
	return out?.members ?? null;
}

export async function addLayerMember(
	layerId: number,
	userId: string,
	role: LayerRoleName,
) {
	const out = await run(() =>
		api.api.layers[":id"].members.$post({
			param: idParam(layerId),
			json: { userId, role },
		}),
	);
	if (out) await loadLayers();
	return out !== null;
}

export async function setLayerMemberRole(
	layerId: number,
	userId: string,
	role: LayerRoleName,
) {
	return (
		(await run(() =>
			api.api.layers[":id"].members[":userId"].$patch({
				param: { ...idParam(layerId), userId },
				json: { role },
			}),
		)) !== null
	);
}

export async function removeLayerMember(layerId: number, userId: string) {
	const out = await run(() =>
		api.api.layers[":id"].members[":userId"].$delete({
			param: { ...idParam(layerId), userId },
		}),
	);
	if (out) await loadLayers();
	return out !== null;
}

export async function loadLayerInvites(
	layerId: number,
): Promise<InviteInfo[] | null> {
	const out = await run<{ invites: InviteInfo[] }>(() =>
		api.api.layers[":id"].invites.$get({ param: idParam(layerId) }),
	);
	return out?.invites ?? null;
}

export function createLayerInvite(layerId: number, input: CreateLayerInvite) {
	return run<CreatedInvite>(() =>
		api.api.layers[":id"].invites.$post({
			param: idParam(layerId),
			json: input,
		}),
	);
}

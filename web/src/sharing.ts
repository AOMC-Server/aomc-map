import {
	type createMapInviteSchema,
	type DimensionTheme,
	type LayerRole,
	layerRoleSchema,
	memberRoleSchema,
	type PreloadRing,
} from "@aomc/shared";
import type { InferResponseType } from "hono/client";
import { api, ok, run } from "./api";
import { refreshMap } from "./controller";
import { mutateOk } from "./layers";
import { user } from "./state";

type MemberRole = (typeof memberRoleSchema.options)[number];

export type Member<R extends string> = {
	userId: string;
	role: R;
	username: string;
	avatarUrl: string | null;
};

export type InviteInfo = InferResponseType<
	typeof api.api.invites.$get,
	200
>["invites"][number];

export type CreatedInvite = InferResponseType<
	typeof api.api.invites.$post,
	201
>;

export type InviteOptions = ReturnType<typeof createMapInviteSchema.parse>;

/** Who can be added to, and invited into, the map or one private layer. */
export type Scope<R extends string> = {
	/** Changes when the scope points at something else. */
	key: string;
	roles: readonly R[];
	defaultRole: R;
	defaultInviteRole: R;
	roleHelp: Record<R, string>;
	/** Roles an invite link can grant; empty when the scope decides it (map invites make moderators). */
	inviteRoles: readonly R[];
	inviteHelp: string;
	load(): Promise<Member<R>[] | null>;
	add(userId: string, role: R): Promise<boolean>;
	setRole(userId: string, role: R): Promise<boolean>;
	remove(userId: string): Promise<boolean>;
	loadInvites(): Promise<InviteInfo[] | null>;
	createInvite(options: InviteOptions, role: R): Promise<CreatedInvite | null>;
};

/** Changing your own membership changes what you may do, so the cached role is re-read. */
const ownChange = (userId: string) =>
	userId === user.value?.id ? refreshMap : undefined;

export const mapScope: Scope<MemberRole> = {
	key: "map",
	roles: memberRoleSchema.options,
	defaultRole: "moderator",
	defaultInviteRole: "moderator",
	roleHelp: {
		moderator: "can delete uploads, restore features and manage dimensions",
		owner: "can also manage members, invites and settings",
	},
	inviteRoles: [],
	inviteHelp: "Anyone who accepts the invite becomes a moderator.",
	async load() {
		const out = await run(() => api.api.members.$get());
		return out?.members ?? null;
	},
	add: (userId, role) =>
		ok(() => api.api.members.$post({ json: { userId, role } })),
	setRole: (userId, role) =>
		ok(
			() =>
				api.api.members[":userId"].$patch({
					param: { userId },
					json: { role },
				}),
			ownChange(userId),
		),
	remove: (userId) =>
		ok(
			() => api.api.members[":userId"].$delete({ param: { userId } }),
			ownChange(userId),
		),
	async loadInvites() {
		const out = await run(() => api.api.invites.$get());
		return out?.invites ?? null;
	},
	createInvite: (options) =>
		run(() => api.api.invites.$post({ json: options })),
};

export function layerScope(layerId: number): Scope<LayerRole> {
	const param = { id: String(layerId) };
	return {
		key: `layer-${layerId}`,
		roles: layerRoleSchema.options,
		defaultRole: "viewer",
		defaultInviteRole: "editor",
		roleHelp: {
			viewer: "can see the layer",
			editor: "can also edit its features",
		},
		inviteRoles: layerRoleSchema.options,
		inviteHelp: "",
		async load() {
			const out = await run(() =>
				api.api.layers[":id"].members.$get({ param }),
			);
			return out?.members ?? null;
		},
		add: (userId, role) =>
			mutateOk(() =>
				api.api.layers[":id"].members.$post({ param, json: { userId, role } }),
			),
		setRole: (userId, role) =>
			mutateOk(() =>
				api.api.layers[":id"].members[":userId"].$patch({
					param: { ...param, userId },
					json: { role },
				}),
			),
		remove: (userId) =>
			mutateOk(() =>
				api.api.layers[":id"].members[":userId"].$delete({
					param: { ...param, userId },
				}),
			),
		async loadInvites() {
			const out = await run(() =>
				api.api.layers[":id"].invites.$get({ param }),
			);
			return out?.invites ?? null;
		},
		createInvite: (options, role) =>
			run(() =>
				api.api.layers[":id"].invites.$post({
					param,
					json: { ...options, role },
				}),
			),
	};
}

export const revokeInvite = (id: number) =>
	ok(() => api.api.invites[":id"].$delete({ param: { id: String(id) } }));

// Map settings and dimensions

const mapChange = (call: Parameters<typeof ok>[0]) => ok(call, refreshMap);

export const updateMapName = (name: string) =>
	mapChange(() => api.api.map.$patch({ json: { name } }));

export const setMaintenance = (maintenance: boolean) =>
	mapChange(() => api.api.map.$patch({ json: { maintenance } }));

export const addDimension = (
	slug: string,
	name: string,
	scale: number | null = null,
	theme?: DimensionTheme,
) =>
	mapChange(() =>
		api.api.dimensions.$post({ json: { slug, name, scale, theme } }),
	);

export const updateDimension = (
	dim: string,
	patch: {
		name?: string;
		sortOrder?: number;
		archived?: boolean;
		scale?: number | null;
		theme?: DimensionTheme;
		preload?: PreloadRing[];
		xaeroDimension?: string;
	},
) =>
	mapChange(() =>
		api.api.dimensions[":dim"].$patch({ param: { dim }, json: patch }),
	);

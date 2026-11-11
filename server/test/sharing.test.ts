import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
	dimensions,
	invites,
	layerMembers,
	mapMembers,
	maps,
} from "../src/db/schema";
import { runSetup } from "../src/setup";
import { makeTestApp, makeUser } from "./helpers";

type Auth = { auth: Record<string, string> } | null;
type Ctx = Awaited<ReturnType<typeof boot>>;

async function boot() {
	const t = makeTestApp();
	await runSetup(t.db, t.env);
	const [map] = await t.db.select().from(maps);
	const mapId = (map as { id: number }).id;
	const owner = await makeUser(t.db, "owner", "Olive");
	const editor = await makeUser(t.db, "editor", "Eddie");
	const mod = await makeUser(t.db, "mod", "Moddy");
	await t.db.insert(mapMembers).values([
		{ mapId, userId: "owner", role: "owner" },
		{ mapId, userId: "mod", role: "moderator" },
	]);
	return { ...t, mapId, owner, editor, mod };
}

async function call(
	t: Ctx,
	user: Auth,
	method: string,
	path: string,
	body?: unknown,
) {
	const headers: Record<string, string> = { ...(user?.auth ?? {}) };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await t.app.request(path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function mapInvite(
	t: Ctx,
	body: object = { role: "editor" },
	user: Auth = t.owner,
) {
	const res = await call(t, user, "POST", "/api/maps/aomc/invites", body);
	expect(res.status).toBe(201);
	return res.body as { invite: { id: number }; token: string; url: string };
}

describe("map invites", () => {
	test("owners create invites; the token is shown once and is never listed", async () => {
		const t = await boot();
		const made = await mapInvite(t, { role: "moderator" });
		expect(made.token.startsWith("inv_")).toBe(true);
		expect(made.url).toBe(`http://localhost:3000/invite/${made.token}`);

		const list = await call(t, t.owner, "GET", "/api/maps/aomc/invites");
		expect(list.status).toBe(200);
		expect(list.body.invites).toHaveLength(1);
		expect(list.body.invites[0]).toMatchObject({
			kind: "map",
			role: "moderator",
			status: "active",
			uses: 0,
			maxUses: null,
			createdByName: "Olive",
		});
		expect(JSON.stringify(list.body)).not.toContain(made.token);
		const [stored] = await t.db.select().from(invites);
		expect(stored?.tokenHash).not.toBe(made.token);
		expect(stored?.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
	});

	test("input is validated and ownership cannot be handed out by link", async () => {
		const t = await boot();
		const post = (body: object) =>
			call(t, t.owner, "POST", "/api/maps/aomc/invites", body);
		expect((await post({ role: "owner" })).status).toBe(400);
		expect((await post({ role: "admin" })).status).toBe(400);
		expect((await post({ role: "editor", expiresInHours: 0 })).status).toBe(
			400,
		);
		expect((await post({ role: "editor", maxUses: 0 })).status).toBe(400);
		const forever = await post({
			role: "viewer",
			expiresInHours: null,
			maxUses: 5,
		});
		expect(forever.status).toBe(201);
		expect(forever.body.invite).toMatchObject({ expiresAt: null, maxUses: 5 });
	});

	test("only owners may list, create or revoke", async () => {
		const t = await boot();
		const made = await mapInvite(t);
		for (const user of [t.mod, t.editor]) {
			expect(
				(await call(t, user, "GET", "/api/maps/aomc/invites")).status,
			).toBe(403);
			expect(
				(
					await call(t, user, "POST", "/api/maps/aomc/invites", {
						role: "viewer",
					})
				).status,
			).toBe(403);
			expect(
				(await call(t, user, "DELETE", `/api/invites/${made.invite.id}`))
					.status,
			).toBe(403);
		}
		expect((await call(t, null, "GET", "/api/maps/aomc/invites")).status).toBe(
			401,
		);
		expect(
			(await call(t, null, "DELETE", `/api/invites/${made.invite.id}`)).status,
		).toBe(401);
		expect(
			(await call(t, t.owner, "DELETE", `/api/invites/${made.invite.id}`))
				.status,
		).toBe(200);
		expect((await call(t, t.owner, "DELETE", "/api/invites/9999")).status).toBe(
			404,
		);
	});

	test("preview works without logging in and reports what the invite is for", async () => {
		const t = await boot();
		const made = await mapInvite(t, { role: "moderator" });
		const res = await call(t, null, "GET", `/api/invites/${made.token}`);
		expect(res.status).toBe(200);
		expect(res.body.invite).toMatchObject({
			kind: "map",
			role: "moderator",
			mapName: "AOMC",
			mapSlug: "aomc",
			layerName: null,
			inviterName: "Olive",
			alreadyMember: false,
		});
		const other = await makeUser(t.db, "someone");
		expect(
			(await call(t, other, "GET", `/api/invites/${made.token}`)).body.invite
				.alreadyMember,
		).toBe(false);
		expect(
			(await call(t, t.owner, "GET", `/api/invites/${made.token}`)).body.invite
				.alreadyMember,
		).toBe(true);
	});

	test("unknown or malformed tokens are 404", async () => {
		const t = await boot();
		for (const bad of [`inv_${"x".repeat(40)}`, "nope", "inv_short"]) {
			expect((await call(t, null, "GET", `/api/invites/${bad}`)).status).toBe(
				404,
			);
			expect(
				(await call(t, t.editor, "POST", `/api/invites/${bad}/accept`)).status,
			).toBe(404);
		}
	});

	test("accepting needs an account, grants the role, and counts a use once", async () => {
		const t = await boot();
		const made = await mapInvite(t, { role: "moderator" });
		expect(
			(await call(t, null, "POST", `/api/invites/${made.token}/accept`)).status,
		).toBe(401);

		const fresh = await makeUser(t.db, "fresh");
		const res = await call(
			t,
			fresh,
			"POST",
			`/api/invites/${made.token}/accept`,
		);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			kind: "map",
			mapSlug: "aomc",
			role: "moderator",
			alreadyMember: false,
		});
		const [member] = await t.db
			.select()
			.from(mapMembers)
			.where(eq(mapMembers.userId, "fresh"));
		expect(member?.role).toBe("moderator");

		const again = await call(
			t,
			fresh,
			"POST",
			`/api/invites/${made.token}/accept`,
		);
		expect(again.body.alreadyMember).toBe(true);
		const [row] = await t.db.select().from(invites);
		expect(row?.uses).toBe(1);
	});

	test("roles only ever go up: no downgrades, and a viewer link adds nothing on a public map", async () => {
		const t = await boot();
		const viewerLink = await mapInvite(t, { role: "viewer" });
		const editorLink = await mapInvite(t, { role: "editor" });

		// A logged-in non-member is already an implicit editor on a public map.
		const res = await call(
			t,
			t.editor,
			"POST",
			`/api/invites/${viewerLink.token}/accept`,
		);
		expect(res.body).toMatchObject({ alreadyMember: true, role: "editor" });
		expect(
			await t.db
				.select()
				.from(mapMembers)
				.where(eq(mapMembers.userId, "editor")),
		).toHaveLength(0);

		// A moderator accepting an editor link stays a moderator.
		const mod = await call(
			t,
			t.mod,
			"POST",
			`/api/invites/${editorLink.token}/accept`,
		);
		expect(mod.body).toMatchObject({ alreadyMember: true, role: "moderator" });

		// An explicit viewer is upgraded.
		const restricted = await makeUser(t.db, "restricted");
		await t.db
			.insert(mapMembers)
			.values({ mapId: t.mapId, userId: "restricted", role: "viewer" });
		const up = await call(
			t,
			restricted,
			"POST",
			`/api/invites/${editorLink.token}/accept`,
		);
		expect(up.body).toMatchObject({ alreadyMember: false, role: "editor" });
	});

	test("revoked, expired and used-up invites are refused with 410", async () => {
		const t = await boot();
		const revoked = await mapInvite(t);
		await call(t, t.owner, "DELETE", `/api/invites/${revoked.invite.id}`);
		const expired = await mapInvite(t);
		await t.db
			.update(invites)
			.set({ expiresAt: Date.now() - 1000 })
			.where(eq(invites.id, expired.invite.id));
		const single = await mapInvite(t, { role: "moderator", maxUses: 1 });

		const a = await makeUser(t.db, "a");
		const b = await makeUser(t.db, "b");
		for (const [token, word] of [
			[revoked.token, "revoked"],
			[expired.token, "expired"],
		] as const) {
			const preview = await call(t, null, "GET", `/api/invites/${token}`);
			expect(preview.status).toBe(410);
			expect(preview.body.reason).toBe(word);
			const accept = await call(t, a, "POST", `/api/invites/${token}/accept`);
			expect(accept.status).toBe(410);
			expect(accept.body.error).toContain(word);
		}

		expect(
			(await call(t, a, "POST", `/api/invites/${single.token}/accept`)).status,
		).toBe(200);
		const used = await call(
			t,
			b,
			"POST",
			`/api/invites/${single.token}/accept`,
		);
		expect(used.status).toBe(410);
		expect(used.body.error).toContain("exhausted");
		expect((await call(t, null, "GET", `/api/maps/aomc/invites`)).status).toBe(
			401,
		);
		const list = await call(t, t.owner, "GET", "/api/maps/aomc/invites");
		expect(
			list.body.invites.map((i: { status: string }) => i.status).sort(),
		).toEqual(["exhausted", "expired", "revoked"]);
	});
});

async function privateLayer(
	t: Ctx,
	opts: { mapSlug?: string; creator?: Auth } = {},
) {
	const slug = opts.mapSlug ?? "aomc";
	const creator = opts.creator ?? t.editor;
	const [map] = await t.db.select().from(maps).where(eq(maps.slug, slug));
	await t.db
		.insert(dimensions)
		.values({
			mapId: (map as { id: number }).id,
			slug: "overworld",
			name: "Overworld",
		})
		.onConflictDoNothing();
	const res = await call(t, creator, "POST", `/api/maps/${slug}/layers`, {
		dimension: "overworld",
		name: "Secret",
		color: "red",
		visibility: "private",
	});
	expect(res.status).toBe(201);
	return res.body.layer as { id: number };
}

const layerNames = async (t: Ctx, user: Auth, slug = "aomc") =>
	(
		(await call(t, user, "GET", `/api/maps/${slug}/layers`)).body.layers as {
			name: string;
		}[]
	).map((l) => l.name);

describe("layer invites", () => {
	test("the creator and moderators can invite; others cannot even see the layer", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const path = `/api/layers/${layer.id}/invites`;

		const made = await call(t, t.editor, "POST", path, { role: "viewer" });
		expect(made.status).toBe(201);
		expect(made.body.invite).toMatchObject({ kind: "layer", role: "viewer" });
		expect(
			(await call(t, t.mod, "POST", path, { role: "editor" })).status,
		).toBe(201);
		expect((await call(t, t.editor, "GET", path)).body.invites).toHaveLength(2);

		const stranger = await makeUser(t.db, "stranger");
		expect(
			(await call(t, stranger, "POST", path, { role: "viewer" })).status,
		).toBe(404);
		expect((await call(t, null, "GET", path)).status).toBe(401);
		// Layer invites only offer viewer and editor.
		expect(
			(await call(t, t.editor, "POST", path, { role: "moderator" })).status,
		).toBe(400);
	});

	test("a layer viewer cannot hand out links", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const viewer = await makeUser(t.db, "lviewer");
		await t.db
			.insert(layerMembers)
			.values({ layerId: layer.id, userId: "lviewer", role: "viewer" });
		expect(
			(
				await call(t, viewer, "POST", `/api/layers/${layer.id}/invites`, {
					role: "viewer",
				})
			).status,
		).toBe(403);
	});

	test("accepting makes someone a layer member; the layer then shows up for them", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const stranger = await makeUser(t.db, "stranger");
		expect(await layerNames(t, stranger)).toEqual([]);

		const made = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/invites`,
			{ role: "viewer" },
		);
		const preview = await call(
			t,
			null,
			"GET",
			`/api/invites/${made.body.token}`,
		);
		expect(preview.body.invite).toMatchObject({
			kind: "layer",
			layerName: "Secret",
			mapSlug: "aomc",
		});

		const res = await call(
			t,
			stranger,
			"POST",
			`/api/invites/${made.body.token}/accept`,
		);
		expect(res.body).toEqual({
			kind: "layer",
			mapSlug: "aomc",
			role: "viewer",
			alreadyMember: false,
		});
		expect(await layerNames(t, stranger)).toEqual(["Secret"]);

		// Viewer access is read-only; an editor link upgrades it, and a later viewer link never downgrades.
		const editorLink = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/invites`,
			{ role: "editor" },
		);
		await call(
			t,
			stranger,
			"POST",
			`/api/invites/${editorLink.body.token}/accept`,
		);
		const [row] = await t.db
			.select()
			.from(layerMembers)
			.where(eq(layerMembers.userId, "stranger"));
		expect(row?.role).toBe("editor");
		const again = await call(
			t,
			stranger,
			"POST",
			`/api/invites/${made.body.token}/accept`,
		);
		expect(again.body.alreadyMember).toBe(true);
		const [still] = await t.db
			.select()
			.from(layerMembers)
			.where(eq(layerMembers.userId, "stranger"));
		expect(still?.role).toBe("editor");
	});

	test("a deleted layer invalidates its invites", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const made = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/invites`,
			{ role: "viewer" },
		);
		await call(t, t.editor, "DELETE", `/api/layers/${layer.id}`);
		const stranger = await makeUser(t.db, "stranger");
		expect(
			(
				await call(
					t,
					stranger,
					"POST",
					`/api/invites/${made.body.token}/accept`,
				)
			).status,
		).toBe(404);
		expect(
			(await call(t, null, "GET", `/api/invites/${made.body.token}`)).status,
		).toBe(410);
	});

	test("layer managers can revoke their invites; strangers cannot", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const made = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${layer.id}/invites`,
			{ role: "viewer" },
		);
		const stranger = await makeUser(t.db, "stranger");
		expect(
			(await call(t, stranger, "DELETE", `/api/invites/${made.body.invite.id}`))
				.status,
		).toBe(404);
		expect(
			(await call(t, t.editor, "DELETE", `/api/invites/${made.body.invite.id}`))
				.status,
		).toBe(200);
		expect(
			(await call(t, null, "GET", `/api/invites/${made.body.token}`)).status,
		).toBe(410);
	});
});

describe("layer members", () => {
	test("managers list, add, change and remove members", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const path = `/api/layers/${layer.id}/members`;
		const friend = await makeUser(t.db, "friend", "Frieda");

		const initial = await call(t, t.editor, "GET", path);
		expect(initial.body.members).toEqual([
			expect.objectContaining({
				userId: "editor",
				role: "editor",
				username: "Eddie",
			}),
		]);

		expect(
			(
				await call(t, t.editor, "POST", path, {
					userId: "friend",
					role: "viewer",
				})
			).status,
		).toBe(201);
		expect(await layerNames(t, friend)).toEqual(["Secret"]);
		expect(
			(await call(t, t.editor, "PATCH", `${path}/friend`, { role: "editor" }))
				.status,
		).toBe(200);
		const listed = await call(t, t.mod, "GET", path);
		expect(
			listed.body.members.find(
				(m: { userId: string }) => m.userId === "friend",
			),
		).toMatchObject({
			role: "editor",
			username: "Frieda",
		});
		expect((await call(t, t.editor, "DELETE", `${path}/friend`)).status).toBe(
			200,
		);
		expect(await layerNames(t, friend)).toEqual([]);
		expect((await call(t, t.editor, "DELETE", `${path}/friend`)).status).toBe(
			404,
		);
		expect(
			(await call(t, t.editor, "PATCH", `${path}/friend`, { role: "viewer" }))
				.status,
		).toBe(404);
	});

	test("validation and unknown users", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const path = `/api/layers/${layer.id}/members`;
		expect(
			(
				await call(t, t.editor, "POST", path, {
					userId: "ghost",
					role: "viewer",
				})
			).status,
		).toBe(404);
		expect(
			(await call(t, t.editor, "POST", path, { userId: "mod", role: "owner" }))
				.status,
		).toBe(400);
		expect(
			(await call(t, t.editor, "POST", path, { role: "viewer" })).status,
		).toBe(400);
	});

	test("members who are not managers cannot see or change the list, but may leave", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const path = `/api/layers/${layer.id}/members`;
		const friend = await makeUser(t.db, "friend");
		await call(t, t.editor, "POST", path, { userId: "friend", role: "editor" });

		expect((await call(t, friend, "GET", path)).status).toBe(403);
		expect(
			(await call(t, friend, "POST", path, { userId: "mod", role: "viewer" }))
				.status,
		).toBe(403);
		expect((await call(t, friend, "DELETE", `${path}/editor`)).status).toBe(
			403,
		);
		expect((await call(t, friend, "DELETE", `${path}/friend`)).status).toBe(
			200,
		);
		expect(await layerNames(t, friend)).toEqual([]);
	});

	test("outsiders and anonymous users get nothing", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		const path = `/api/layers/${layer.id}/members`;
		const stranger = await makeUser(t.db, "stranger");
		expect((await call(t, stranger, "GET", path)).status).toBe(404);
		expect(
			(
				await call(t, stranger, "POST", path, {
					userId: "stranger",
					role: "viewer",
				})
			).status,
		).toBe(404);
		expect((await call(t, null, "GET", path)).status).toBe(401);
	});

	test("the layer list says who may manage it", async () => {
		const t = await boot();
		const layer = await privateLayer(t);
		await call(t, t.editor, "POST", `/api/layers/${layer.id}/members`, {
			userId: "mod",
			role: "viewer",
		});
		const flag = async (user: Auth) =>
			(await call(t, user, "GET", "/api/maps/aomc/layers")).body.layers[0]
				.canManage;
		expect(await flag(t.editor)).toBe(true);
		expect(await flag(t.mod)).toBe(true);
		expect(await flag(t.owner)).toBe(true);
		const friend = await makeUser(t.db, "friend");
		await call(t, t.editor, "POST", `/api/layers/${layer.id}/members`, {
			userId: "friend",
			role: "editor",
		});
		expect(await flag(friend)).toBe(false);
	});
});

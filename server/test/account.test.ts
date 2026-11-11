import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DELETED_USER_NAME } from "../src/account";
import {
	apiTokens,
	featureRevisions,
	invites,
	layers,
	members,
	revisions,
	sessions,
	shortLinks,
	users,
} from "../src/db/schema";
import {
	addMember,
	bootTiles,
	call,
	cleanupTempDirs,
	makeSessionCookie,
	makeUser,
	RED,
	solid,
	T,
	type TileApp,
	upload,
} from "./helpers";

afterAll(cleanupTempDirs);

/** Requests as a logged-in browser: the session cookie, from the site's own origin. */
async function browser(t: TileApp, userId: string) {
	return {
		auth: {
			Cookie: await makeSessionCookie(t.db, userId),
			Origin: "http://localhost:3000",
		},
	};
}

/** Gives the editor one of everything: an upload, a layer with a pin, an invite, a short link. */
async function contribute(t: TileApp) {
	const revisionId = await upload(t, await solid(T, T, RED), 0, 0);
	const layer = await call(t, t.editor, "POST", "/api/layers", {
		dimension: "overworld",
		name: "Bases",
		color: "red",
		visibility: "private",
	});
	expect(layer.status).toBe(201);
	const layerId = layer.body.layer.id as number;
	const pin = await call(
		t,
		t.editor,
		"POST",
		`/api/layers/${layerId}/features`,
		{
			type: "pin",
			name: "Home",
			popup: "",
			color: null,
			geometry: [1, 2],
		},
	);
	expect(pin.status).toBe(201);
	expect(
		(
			await call(t, t.editor, "POST", `/api/layers/${layerId}/invites`, {
				role: "viewer",
			})
		).status,
	).toBe(201);
	expect(
		(
			await call(t, t.editor, "POST", "/api/links", {
				dim: "overworld",
				x: 0,
				z: 0,
				zoom: 0,
			})
		).status,
	).toBe(201);
	return { revisionId, layerId, featureId: pin.body.feature.id as number };
}

describe("download your data", () => {
	test("lists what is stored about you, without secrets", async () => {
		const t = await bootTiles();
		const { layerId } = await contribute(t);
		const res = await call(t, t.editor, "GET", "/api/me/export");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Disposition")).toContain("attachment");
		const data = res.body;
		expect(data.account).toMatchObject({
			discordId: "editor",
			username: "editor",
		});
		expect(data.uploads).toHaveLength(1);
		expect(data.uploads[0].dimension).toBe("overworld");
		expect(data.layersCreated.map((l: { id: number }) => l.id)).toEqual([
			layerId,
		]);
		expect(data.featureEdits).toHaveLength(1);
		expect(data.featureEdits[0].name).toBe("Home");
		expect(data.invitesCreated).toHaveLength(1);
		expect(data.shortLinks).toHaveLength(1);
		expect(data.apiTokens).toHaveLength(1);
		expect(JSON.stringify(data)).not.toContain("tokenHash");
		expect(JSON.stringify(data)).not.toContain("token_hash");
	});

	test("needs a login", async () => {
		const t = await bootTiles();
		expect((await call(t, null, "GET", "/api/me/export")).status).toBe(401);
	});
});

describe("delete your account", () => {
	test("removes the login and everything identifying; contributions stay as Deleted user", async () => {
		const t = await bootTiles();
		const { revisionId, layerId, featureId } = await contribute(t);
		const me = await browser(t, "editor");

		const res = await call(t, me, "DELETE", "/api/me");
		expect(res.status).toBe(200);
		expect(res.headers.get("Set-Cookie")).toContain("aomc_session=;");

		expect(t.db.select().from(users).where(eq(users.id, "editor")).get()).toBe(
			undefined,
		);
		expect(
			t.db.select().from(sessions).where(eq(sessions.userId, "editor")).all(),
		).toEqual([]);
		expect(
			t.db.select().from(apiTokens).where(eq(apiTokens.userId, "editor")).all(),
		).toEqual([]);
		expect(t.db.select().from(invites).all()).toEqual([]);
		expect(t.db.select().from(shortLinks).get()?.createdBy).toBeNull();

		// The map keeps the contributions, under a placeholder that is nobody.
		const author = t.db
			.select({ authorId: revisions.authorId })
			.from(revisions)
			.where(eq(revisions.id, revisionId))
			.get()?.authorId as string;
		expect(author).toStartWith("deleted-");
		expect(
			t.db.select().from(users).where(eq(users.id, author)).get(),
		).toMatchObject({ username: DELETED_USER_NAME, avatarUrl: null });
		expect(
			t.db.select().from(layers).where(eq(layers.id, layerId)).get()?.createdBy,
		).toBe(author);
		expect(
			t.db
				.select()
				.from(featureRevisions)
				.where(eq(featureRevisions.featureId, featureId))
				.get()?.authorId,
		).toBe(author);

		// The old session and token no longer work.
		expect((await call(t, me, "GET", "/api/me")).body.user).toBeNull();
		expect((await call(t, t.editor, "GET", "/api/me")).status).toBe(401);
	});

	test("each deleted account gets its own placeholder", async () => {
		const t = await bootTiles();
		await upload(t, await solid(T, T, RED), 0, 0, t.editor);
		const other = await makeUser(t.db, "other");
		await upload(t, await solid(T, T, RED), T, 0, other);
		await call(t, await browser(t, "editor"), "DELETE", "/api/me");
		await call(t, await browser(t, "other"), "DELETE", "/api/me");
		const authors = new Set(
			t.db
				.select({ a: revisions.authorId })
				.from(revisions)
				.all()
				.map((r) => r.a),
		);
		expect(authors.size).toBe(2);
	});

	test("needs a browser session, not a token", async () => {
		const t = await bootTiles();
		expect((await call(t, t.editor, "DELETE", "/api/me")).status).toBe(403);
		expect(
			t.db.select().from(users).where(eq(users.id, "editor")).get(),
		).toBeDefined();
	});

	test("the last owner must hand over first; a moderator may leave", async () => {
		const t = await bootTiles({}, { owner: true });
		const owner = await browser(t, "owner");
		expect((await call(t, owner, "DELETE", "/api/me")).status).toBe(409);
		expect(
			t.db.select().from(users).where(eq(users.id, "owner")).get(),
		).toBeDefined();

		await makeUser(t.db, "second");
		await addMember(t, "second", "owner");
		expect((await call(t, owner, "DELETE", "/api/me")).status).toBe(200);
		expect(
			t.db.select().from(members).where(eq(members.userId, "owner")).get(),
		).toBeUndefined();

		expect(
			(await call(t, await browser(t, "mod"), "DELETE", "/api/me")).status,
		).toBe(200);
	});
});

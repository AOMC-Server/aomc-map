import { afterAll, describe, expect, test } from "bun:test";
import { bootTiles, call, cleanupTempDirs, RED, solid, T } from "./helpers";

afterAll(cleanupTempDirs);

const layerBody = { dimension: "overworld", name: "Bases", color: "red" };

async function bootInMaintenance() {
	const t = await bootTiles({}, { owner: true });
	const layer = await call(t, t.editor, "POST", "/api/layers", layerBody);
	expect(layer.status).toBe(201);
	const on = await call(t, t.owner, "PATCH", "/api/map", {
		maintenance: true,
	});
	expect(on.status).toBe(200);
	expect(on.body.map.maintenance).toBe(true);
	return { ...t, layerId: layer.body.layer.id as number };
}

describe("maintenance mode", () => {
	test("is off by default and shown in the map details", async () => {
		const t = await bootTiles();
		const res = await call(t, null, "GET", "/api/map");
		expect(res.body.map.maintenance).toBe(false);
	});

	test("only owners can turn it on", async () => {
		const t = await bootTiles();
		const res = await call(t, t.mod, "PATCH", "/api/map", {
			maintenance: true,
		});
		expect(res.status).toBe(403);
	});

	test("refuses writes by editors and moderators", async () => {
		const t = await bootInMaintenance();
		for (const user of [t.editor, t.mod]) {
			const res = await call(t, user, "POST", "/api/layers", layerBody);
			expect(res.status).toBe(503);
			expect(res.body.reason).toBe("maintenance");
		}
		const pin = await call(
			t,
			t.editor,
			"POST",
			`/api/layers/${t.layerId}/features`,
			{ type: "pin", name: "Base", geometry: [1, 2] },
		);
		expect(pin.status).toBe(503);
		const dim = await call(t, t.mod, "PATCH", "/api/dimensions/overworld", {
			name: "Surface",
		});
		expect(dim.status).toBe(503);

		const form = new FormData();
		form.append("files[]", new File([await solid(T, T, RED)], "0_0.png"));
		const up = await t.app.request("/api/dimensions/overworld/uploads", {
			method: "POST",
			body: form,
			headers: t.editor.auth,
		});
		expect(up.status).toBe(503);
	});

	test("still lets everyone read, and says nothing is editable", async () => {
		const t = await bootInMaintenance();
		const layers = await call(t, t.editor, "GET", "/api/layers");
		expect(layers.status).toBe(200);
		const layer = layers.body.layers.find(
			(l: { id: number }) => l.id === t.layerId,
		);
		expect(layer).toMatchObject({ canEdit: false, canManage: false });
		const map = await call(t, t.mod, "GET", "/api/map");
		expect(map.body.role).toBe("moderator");
	});

	test("owners keep writing and can turn it off", async () => {
		const t = await bootInMaintenance();
		const created = await call(t, t.owner, "POST", "/api/layers", layerBody);
		expect(created.status).toBe(201);
		const layers = await call(t, t.owner, "GET", "/api/layers");
		expect(
			layers.body.layers.every((l: { canEdit: boolean }) => l.canEdit),
		).toBe(true);

		const off = await call(t, t.owner, "PATCH", "/api/map", {
			maintenance: false,
		});
		expect(off.status).toBe(200);
		const again = await call(t, t.editor, "POST", "/api/layers", layerBody);
		expect(again.status).toBe(201);
	});

	test("short links and your own tokens still work", async () => {
		const t = await bootInMaintenance();
		const link = await call(t, null, "POST", "/api/links", {
			dim: "overworld",
			x: 0,
			z: 0,
			zoom: 1,
		});
		expect(link.status).toBe(201);
		const token = await t.app.request("/api/tokens", {
			method: "POST",
			headers: {
				...t.editor.auth,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "script" }),
		});
		expect(token.status).not.toBe(503);
	});
});

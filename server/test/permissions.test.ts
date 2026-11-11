import { describe, expect, test } from "bun:test";
import type { Role } from "@aomc/shared";
import {
	canChangeTileSize,
	canCreateLayers,
	canDeleteLayer,
	canEditFeatures,
	canEditLayer,
	canManageDimensions,
	canManageInvites,
	canManageLayerMembers,
	canManageMembers,
	canModerate,
	canUpload,
	canViewLayer,
	effectiveRole,
	type LayerRole,
	leavesNoOwner,
} from "../src/permissions";

const user = { id: "u1" };
const map = { headRev: 0 };
const roles: Role[] = ["viewer", "editor", "moderator", "owner"];

describe("effectiveRole", () => {
	const cases: [string, Parameters<typeof effectiveRole>, Role][] = [
		["anonymous visitor", [null, null], "viewer"],
		["logged-in non-member is an implicit editor", [user, null], "editor"],
		["an explicit viewer stays a viewer", [user, "viewer"], "viewer"],
		["explicit moderator", [user, "moderator"], "moderator"],
		["explicit owner", [user, "owner"], "owner"],
	];
	for (const [name, args, expected] of cases) {
		test(name, () => expect(effectiveRole(...args)).toBe(expected));
	}
});

describe("map capabilities by role", () => {
	// [role, upload/edit/createLayer, moderate, manageMembers, manageDimensions]
	const table: [Role, boolean, boolean, boolean, boolean][] = [
		["viewer", false, false, false, false],
		["editor", true, false, false, false],
		["moderator", true, true, false, true],
		["owner", true, true, true, true],
	];
	for (const [role, edit, mod, members, dims] of table) {
		test(`role ${role}`, () => {
			expect(canUpload(role)).toBe(edit);
			expect(canEditFeatures(role)).toBe(edit);
			expect(canCreateLayers(role)).toBe(edit);
			expect(canModerate(role)).toBe(mod);
			expect(canManageMembers(role)).toBe(members);
			expect(canManageInvites(role)).toBe(members);
			expect(canManageDimensions(role)).toBe(dims);
		});
	}
});

describe("canChangeTileSize", () => {
	for (const role of roles) {
		test(`role ${role}`, () => {
			expect(canChangeTileSize(role, map)).toBe(role === "owner");
			expect(canChangeTileSize(role, { headRev: 1 })).toBe(false);
		});
	}
});

describe("layer permissions", () => {
	const inherit = { visibility: "inherit", createdBy: "someone" } as const;
	const priv = { visibility: "private", createdBy: "someone" } as const;
	const layerRoles: LayerRole[] = [null, "viewer", "editor"];

	for (const role of roles) {
		for (const lr of layerRoles) {
			test(`inherit layer: map ${role}, layer ${lr}`, () => {
				expect(canViewLayer(role, inherit, lr)).toBe(true);
				expect(canEditLayer(role, inherit, lr)).toBe(role !== "viewer");
			});

			test(`private layer: map ${role}, layer ${lr}`, () => {
				const mod = role === "moderator" || role === "owner";
				expect(canViewLayer(role, priv, lr)).toBe(mod || lr !== null);
				expect(canEditLayer(role, priv, lr)).toBe(
					mod || (role !== "viewer" && lr === "editor"),
				);
			});
		}
	}

	test("private layer editor membership does not help a map viewer edit", () => {
		expect(canEditLayer("viewer", priv, "editor")).toBe(false);
	});
});

describe("canDeleteLayer", () => {
	const mine = { visibility: "inherit", createdBy: "u1" } as const;
	const theirs = { visibility: "inherit", createdBy: "u2" } as const;
	test("creator editor can delete own layer", () => {
		expect(canDeleteLayer(user, "editor", mine)).toBe(true);
	});
	test("editor cannot delete others' layer", () => {
		expect(canDeleteLayer(user, "editor", theirs)).toBe(false);
	});
	test("moderator can delete others' layer", () => {
		expect(canDeleteLayer(user, "moderator", theirs)).toBe(true);
	});
	test("viewer cannot delete own layer", () => {
		expect(canDeleteLayer(user, "viewer", mine)).toBe(false);
	});
	test("anonymous cannot delete", () => {
		expect(canDeleteLayer(null, "viewer", mine)).toBe(false);
	});
});

describe("canManageLayerMembers", () => {
	const layer = { visibility: "private", createdBy: "u1" } as const;
	test("moderators, or the layer's creator while they can still edit", () => {
		expect(canManageLayerMembers(user, "moderator", layer)).toBe(true);
		expect(canManageLayerMembers(user, "editor", layer)).toBe(true);
		expect(canManageLayerMembers(user, "viewer", layer)).toBe(false);
		expect(canManageLayerMembers({ id: "u2" }, "editor", layer)).toBe(false);
		expect(canManageLayerMembers(null, "viewer", layer)).toBe(false);
	});
});

describe("leavesNoOwner", () => {
	test("sole owner demoted", () =>
		expect(leavesNoOwner(1, "owner", "editor")).toBe(true));
	test("sole owner removed", () =>
		expect(leavesNoOwner(1, "owner", null)).toBe(true));
	test("one of two owners removed", () =>
		expect(leavesNoOwner(2, "owner", null)).toBe(false));
	test("owner stays owner", () =>
		expect(leavesNoOwner(1, "owner", "owner")).toBe(false));
	test("non-owner changes", () =>
		expect(leavesNoOwner(1, "editor", null)).toBe(false));
});

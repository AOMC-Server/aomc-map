import { describe, expect, test } from "bun:test";
import type { Role } from "@aomc/shared";
import {
	canChangeTileSize,
	canCreateLayers,
	canDeleteLayer,
	canEditFeatures,
	canEditLayer,
	canManageDimensions,
	canManageMembers,
	canModerate,
	canUpload,
	canViewLayer,
	canViewMap,
	effectiveRole,
	type LayerRole,
	leavesNoOwner,
	type MapInfo,
} from "../src/permissions";

const user = { id: "u1" };
const pub: MapInfo = { visibility: "public", isDefault: false, headRev: 0 };
const priv: MapInfo = { visibility: "private", isDefault: false, headRev: 0 };
const roles: (Role | null)[] = [null, "viewer", "editor", "moderator", "owner"];

describe("effectiveRole", () => {
	const cases: [string, Parameters<typeof effectiveRole>, Role | null][] = [
		["anonymous on public", [null, pub, null], "viewer"],
		["logged-in non-member on public", [user, pub, null], "editor"],
		["anonymous on private", [null, priv, null], null],
		["logged-in non-member on private", [user, priv, null], null],
		["explicit viewer on public stays viewer", [user, pub, "viewer"], "viewer"],
		["explicit moderator on public", [user, pub, "moderator"], "moderator"],
		["explicit viewer on private", [user, priv, "viewer"], "viewer"],
		["explicit owner on private", [user, priv, "owner"], "owner"],
	];
	for (const [name, args, expected] of cases) {
		test(name, () => expect(effectiveRole(...args)).toBe(expected));
	}
});

describe("map capabilities by role", () => {
	// [role, view, upload/edit/createLayer, moderate, manageMembers]
	const table: [Role | null, boolean, boolean, boolean, boolean][] = [
		[null, false, false, false, false],
		["viewer", true, false, false, false],
		["editor", true, true, false, false],
		["moderator", true, true, true, false],
		["owner", true, true, true, true],
	];
	for (const [role, view, edit, mod, members] of table) {
		test(`role ${role}`, () => {
			expect(canViewMap(role)).toBe(view);
			expect(canUpload(role)).toBe(edit);
			expect(canEditFeatures(role)).toBe(edit);
			expect(canCreateLayers(role)).toBe(edit);
			expect(canModerate(role)).toBe(mod);
			expect(canManageMembers(role)).toBe(members);
		});
	}
});

describe("canManageDimensions", () => {
	const table: [Role | null, boolean, boolean][] = [
		// role, regular map, default map
		[null, false, false],
		["viewer", false, false],
		["editor", false, false],
		["moderator", false, true],
		["owner", true, true],
	];
	for (const [role, regular, isDefault] of table) {
		test(`role ${role}`, () => {
			expect(canManageDimensions(role, pub)).toBe(regular);
			expect(canManageDimensions(role, { ...pub, isDefault: true })).toBe(
				isDefault,
			);
		});
	}
});

describe("canChangeTileSize", () => {
	for (const role of roles) {
		test(`role ${role}`, () => {
			expect(canChangeTileSize(role, pub)).toBe(role === "owner");
			expect(canChangeTileSize(role, { ...pub, headRev: 1 })).toBe(false);
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
				expect(canViewLayer(role, inherit, lr)).toBe(role !== null);
				expect(canEditLayer(role, inherit, lr)).toBe(
					role !== null && role !== "viewer",
				);
			});

			test(`private layer: map ${role}, layer ${lr}`, () => {
				const mod = role === "moderator" || role === "owner";
				expect(canViewLayer(role, priv, lr)).toBe(
					role !== null && (mod || lr !== null),
				);
				const isEditor = role !== null && role !== "viewer";
				expect(canEditLayer(role, priv, lr)).toBe(
					mod || (isEditor && lr === "editor"),
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
		expect(canDeleteLayer(null, null, mine)).toBe(false);
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

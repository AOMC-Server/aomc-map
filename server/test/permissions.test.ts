import { describe, expect, test } from "bun:test";
import type { Role } from "@aomc/shared";
import {
	atLeast,
	canEdit,
	canEditLayer,
	canManage,
	canManageLayer,
	canModerate,
	canViewLayer,
	effectiveRole,
	type LayerRole,
	leavesNoOwner,
} from "../src/permissions";

const user = { id: "u1" };

describe("effectiveRole", () => {
	const cases: [string, Parameters<typeof effectiveRole>, Role][] = [
		["anonymous visitor", [null, null], "viewer"],
		["logged-in non-member is an implicit editor", [user, null], "editor"],
		["explicit moderator", [user, "moderator"], "moderator"],
		["explicit owner", [user, "owner"], "owner"],
	];
	for (const [name, args, expected] of cases) {
		test(name, () => expect(effectiveRole(...args)).toBe(expected));
	}
});

describe("atLeast", () => {
	test("orders viewer < editor < moderator < owner", () => {
		expect(atLeast("viewer", "editor")).toBe(false);
		expect(atLeast("editor", "editor")).toBe(true);
		expect(atLeast("editor", "moderator")).toBe(false);
		expect(atLeast("moderator", "editor")).toBe(true);
		expect(atLeast("moderator", "owner")).toBe(false);
		expect(atLeast("owner", "viewer")).toBe(true);
	});
});

describe("map capabilities by role", () => {
	// [role, canEdit, canModerate, canManage]
	const table: [Role, boolean, boolean, boolean][] = [
		["viewer", false, false, false],
		["editor", true, false, false],
		["moderator", true, true, false],
		["owner", true, true, true],
	];
	for (const [role, edit, moderate, manage] of table) {
		test(role, () => {
			expect(canEdit(role)).toBe(edit);
			expect(canModerate(role)).toBe(moderate);
			expect(canManage(role)).toBe(manage);
		});
	}
});

describe("layer view/edit", () => {
	const pub = { visibility: "public", createdBy: "someone" } as const;
	const priv = { visibility: "private", createdBy: "someone" } as const;

	// [layer, map role, layer role, canView, canEdit]
	const table: [typeof pub | typeof priv, Role, LayerRole, boolean, boolean][] =
		[
			[pub, "viewer", null, true, false],
			[pub, "editor", null, true, true],
			[pub, "editor", "viewer", true, true],
			[pub, "moderator", null, true, true],
			[priv, "viewer", null, false, false],
			[priv, "viewer", "viewer", true, false],
			[priv, "viewer", "editor", true, false],
			[priv, "editor", null, false, false],
			[priv, "editor", "viewer", true, false],
			[priv, "editor", "editor", true, true],
			[priv, "moderator", null, true, true],
			[priv, "moderator", "viewer", true, true],
			[priv, "owner", null, true, true],
		];
	for (const [layer, role, layerRole, view, edit] of table) {
		test(`${layer.visibility} layer: map ${role}, layer ${layerRole}`, () => {
			expect(canViewLayer(role, layer, layerRole)).toBe(view);
			expect(canEditLayer(role, layer, layerRole)).toBe(edit);
		});
	}
});

describe("canManageLayer", () => {
	const mine = { visibility: "public", createdBy: "u1" } as const;
	const theirs = { visibility: "private", createdBy: "u2" } as const;

	// [name, actor, role, layer, expected]
	const table: [
		string,
		Parameters<typeof canManageLayer>[0],
		Role,
		typeof mine | typeof theirs,
		boolean,
	][] = [
		["creator editor", user, "editor", mine, true],
		["editor on someone else's layer", user, "editor", theirs, false],
		["moderator on someone else's layer", user, "moderator", theirs, true],
		["owner on someone else's layer", user, "owner", theirs, true],
		["a viewer role cannot manage even their own", user, "viewer", mine, false],
		["anonymous", null, "viewer", mine, false],
	];
	for (const [name, actor, role, layer, expected] of table) {
		test(name, () => {
			expect(canManageLayer(actor, role, layer)).toBe(expected);
		});
	}
});

describe("leavesNoOwner", () => {
	const table: [string, number, Role, Role | null, boolean][] = [
		["sole owner demoted", 1, "owner", "moderator", true],
		["sole owner removed", 1, "owner", null, true],
		["one of two owners removed", 2, "owner", null, false],
		["one of two owners demoted", 2, "owner", "moderator", false],
		["owner stays owner", 1, "owner", "owner", false],
		["moderator removed", 1, "moderator", null, false],
		["moderator promoted", 1, "moderator", "owner", false],
	];
	for (const [name, owners, current, next, expected] of table) {
		test(name, () =>
			expect(leavesNoOwner(owners, current, next)).toBe(expected),
		);
	}
});

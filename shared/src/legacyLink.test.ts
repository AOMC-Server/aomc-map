import { describe, expect, test } from "bun:test";
import { upgradeLegacyQuery, viewerUrlForRoot } from "./legacyLink";

describe("old links", () => {
	test("the zoom level is mirrored around 1:1 (9)", () => {
		expect(upgradeLegacyQuery("?dim=nether&x=100&z=-200&zoom=7")).toBe(
			"dim=nether&x=100&z=-200&zoom=2",
		);
		expect(upgradeLegacyQuery("?x=0&z=0&zoom=9")).toBe("x=0&z=0&zoom=0");
		expect(upgradeLegacyQuery("?x=0&z=0&zoom=12")).toBe("x=0&z=0&zoom=-3");
	});

	test("other parameters are kept", () => {
		expect(upgradeLegacyQuery("?dim=the_end&embed=1&x=1&z=2&zoom=8")).toBe(
			"dim=the_end&embed=1&x=1&z=2&zoom=1",
		);
	});

	test("a link without a full position is left alone", () => {
		expect(upgradeLegacyQuery("?dim=nether")).toBe("dim=nether");
		expect(upgradeLegacyQuery("?zoom=3")).toBe("zoom=3");
		expect(upgradeLegacyQuery("")).toBe("");
	});

	test("a zoom that is not a number is dropped", () => {
		expect(upgradeLegacyQuery("?x=1&z=2&zoom=abc")).toBe("x=1&z=2");
		expect(upgradeLegacyQuery("?x=1&z=2&zoom=")).toBe("x=1&z=2");
	});

	test("the root redirects to the viewer", () => {
		expect(viewerUrlForRoot("")).toBe("/v2/");
		expect(viewerUrlForRoot("?x=1&z=2&zoom=7")).toBe("/v2/?x=1&z=2&zoom=2");
	});
});

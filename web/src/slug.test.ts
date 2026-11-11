import { describe, expect, test } from "bun:test";
import { slugify } from "./slug";

describe("slugify", () => {
	test("makes dimension slugs the server accepts", () => {
		const accepted = /^[a-z0-9][a-z0-9_-]*$/;
		for (const name of [
			"The Nether",
			"  Overworld  Caves ",
			"Ünïcode & symbols!",
			"a".repeat(80),
			"Lost City #2",
		]) {
			const slug = slugify(name);
			expect(slug).toMatch(accepted);
			expect(slug.length).toBeLessThanOrEqual(40);
		}
		expect(slugify("The Nether")).toBe("the_nether");
		expect(slugify("Lost City #2")).toBe("lost_city_2");
	});

	test("nothing usable gives an empty slug", () => {
		expect(slugify("!!!")).toBe("");
		expect(slugify("")).toBe("");
	});
});

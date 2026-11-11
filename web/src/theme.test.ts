import { describe, expect, test } from "bun:test";
import { DIMENSION_THEMES } from "@aomc/shared/schemas";
import { isModeChoice, isStyle, resolveMode, STYLES } from "./theme";

describe("appearance", () => {
	test("validates modes and styles", () => {
		expect(isModeChoice("system")).toBe(true);
		expect(isModeChoice("light")).toBe(true);
		expect(isModeChoice("dim")).toBe(false);
		expect(isStyle("xp")).toBe(true);
		expect(isStyle("vista")).toBe(false);
		expect(isStyle(null)).toBe(false);
	});

	test("system mode follows the system preference", () => {
		expect(resolveMode("system", false)).toBe("dark");
		expect(resolveMode("system", true)).toBe("light");
		expect(resolveMode("dark", true)).toBe("dark");
		expect(resolveMode("light", false)).toBe("light");
	});

	test("styles.css defines every palette in both modes, and every style", async () => {
		const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
		for (const palette of DIMENSION_THEMES) {
			for (const mode of ["dark", "light"]) {
				expect(css).toContain(
					`[data-palette="${palette}"][data-mode="${mode}"]`,
				);
			}
		}
		for (const style of STYLES) {
			expect(css).toContain(`[data-style="${style.id}"]`);
		}
	});

	test("the inline script in index.html knows the same styles and palettes", async () => {
		const html = await Bun.file(
			new URL("../index.html", import.meta.url),
		).text();
		const list = (name: string) =>
			JSON.parse(
				new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(html)?.[1] ?? "null",
			);
		expect(list("STYLES")).toEqual(STYLES.map((s) => s.id));
		expect(list("PALETTES")).toEqual([...DIMENSION_THEMES]);
	});
});

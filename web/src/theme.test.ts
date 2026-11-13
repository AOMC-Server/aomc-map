import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DYE_HEX, DYES } from "@aomc/shared/colors";
import { DIMENSION_THEMES } from "@aomc/shared/schemas";
import {
	appearance,
	dyeScope,
	isModeChoice,
	isStyle,
	resolveMode,
	STYLES,
} from "./theme";

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

describe("dye palettes", () => {
	const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

	test("every dye has one, in the colour the map draws it in", () => {
		for (const dye of DYES) {
			const rule = new RegExp(
				`\\[data-palette="dye-${dye}"\\]\\s*\\{\\s*--dye:\\s*(#[0-9a-f]{6});`,
			).exec(css);
			expect(rule?.[1], dye).toBe(DYE_HEX[dye]);
		}
	});

	test("the dark and light ones set the surfaces and the text", () => {
		for (const mode of ["dark", "light"]) {
			const start = css.indexOf(`[data-palette^="dye-"][data-mode="${mode}"]`);
			expect(start).toBeGreaterThan(0);
			const block = css.slice(start, css.indexOf("}", start));
			for (const token of [
				"--ink",
				"--well",
				"--s1",
				"--s2",
				"--text",
				"--chrome",
			])
				expect(block, `${mode} ${token}`).toContain(`${token}:`);
		}
	});

	test("the tooltip's stronger palette never mixes in more than all of the dye", () => {
		const k = Number(
			/\.dye-scope\.strong\s*\{\s*--dye-k:\s*([\d.]+);/.exec(css)?.[1],
		);
		expect(k).toBeGreaterThan(1);
		const amounts = [
			...css.matchAll(/calc\((\d+)% \* var\(--dye-k, 1\)\)/g),
		].map((m) => Number(m[1]));
		expect(amounts.length).toBeGreaterThan(10);
		for (const n of amounts) expect(n * k).toBeLessThanOrEqual(100);
	});

	test("an element gets the palette with the mode and style in use", () => {
		appearance.value = { mode: "light", palette: "nether", style: "xp" };
		expect(dyeScope("lime")).toEqual({
			"data-palette": "dye-lime",
			"data-mode": "light",
			"data-style": "xp",
		});
		expect(dyeScope(undefined)).toEqual({});
	});
});

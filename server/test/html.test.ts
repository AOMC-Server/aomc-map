import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapInfo } from "../src/db/schema";
import { escapeHtml, injectMeta } from "../src/html";
import { cleanupTempDirs, makeTempDir, makeTestApp } from "./helpers";

afterAll(cleanupTempDirs);

const INDEX = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<title>AOMC Map</title>
	</head>
	<body><div id="app"></div></body>
</html>`;

describe("escapeHtml", () => {
	test("escapes the five dangerous characters", () => {
		expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
		);
	});
});

describe("injectMeta", () => {
	const meta = {
		title: "AOMC: Nether",
		description: "around x 1, z 2",
		url: "https://m.example/?a=1&b=2",
		image: "https://m.example/p.png",
	};

	test("adds open graph and twitter tags and replaces the title", () => {
		const out = injectMeta(INDEX, meta);
		expect(out).toContain("<title>AOMC: Nether</title>");
		expect(out).toContain('<meta property="og:title" content="AOMC: Nether">');
		expect(out).toContain(
			'<meta property="og:url" content="https://m.example/?a=1&amp;b=2">',
		);
		expect(out).toContain(
			'<meta property="og:image" content="https://m.example/p.png">',
		);
		expect(out).toContain('<meta property="og:image:width" content="1200">');
		expect(out).toContain(
			'<meta name="twitter:card" content="summary_large_image">',
		);
		expect(out.indexOf("og:title")).toBeLessThan(out.indexOf("</head>"));
		expect(out).toContain('<div id="app">');
	});

	test("without an image it is a plain summary card", () => {
		const out = injectMeta(INDEX, { ...meta, image: null });
		expect(out).toContain('<meta name="twitter:card" content="summary">');
		expect(out).not.toContain("og:image");
	});

	test("hostile values are escaped everywhere, including the title", () => {
		const evil = `"><script>alert(1)</script><x y="$& $1 $'`;
		const out = injectMeta(INDEX, {
			title: evil,
			description: evil,
			url: evil,
			image: evil,
		});
		expect(out).not.toContain("<script>");
		expect(out).not.toContain('"><script');
		expect(out).not.toContain("<x ");
		expect(out.match(/&lt;script&gt;/g)?.length).toBeGreaterThanOrEqual(8);
		// "$&" style replacement patterns must stay literal.
		expect(out).toContain("$&amp;");
		expect(out.split("</head>")).toHaveLength(2);
	});
});

function bootPage(env: Record<string, string> = {}) {
	const dist = makeTempDir("aomc-dist-");
	writeFileSync(join(dist, "index.html"), INDEX);
	const t = makeTestApp({
		WEB_DIST: dist,
		PUBLIC_URL: "https://map.example.com",
		SESSION_SECRET: "test-secret-0123456789",
		...env,
	});
	return t;
}

const meta = (html: string, key: string) =>
	new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(
		html,
	)?.[1];

describe("share tags on /", () => {
	test("the default view gets a title, description and an absolute preview image", async () => {
		const t = bootPage();
		const html = await (await t.app.request("/")).text();
		expect(html).toContain("<title>AOMC: Overworld</title>");
		expect(meta(html, "og:title")).toBe("AOMC: Overworld");
		expect(meta(html, "og:image")).toBe(
			"https://map.example.com/api/preview.png?dim=overworld&amp;x=0&amp;z=0&amp;zoom=2",
		);
		expect(meta(html, "og:url")).toBe(
			"https://map.example.com/?dim=overworld&amp;x=0&amp;z=0&amp;zoom=2",
		);
	});

	test("the view in the URL is reflected, sanitised to the canonical form", async () => {
		const t = bootPage();
		const html = await (
			await t.app.request(
				"/?dim=nether&x=-12&z=340&zoom=1.234&rev=0&embed=1&junk=<b>",
			)
		).text();
		expect(meta(html, "og:title")).toBe("AOMC: Nether");
		expect(meta(html, "og:description")).toBe(
			"AOMC, Nether, around x -12, z 340 (revision 0)",
		);
		expect(meta(html, "og:image")).toBe(
			"https://map.example.com/api/preview.png?dim=nether&amp;x=-12&amp;z=340&amp;zoom=1.23&amp;rev=0",
		);
		expect(html).not.toContain("junk");
	});

	test("a map name cannot break out of the markup", async () => {
		const t = bootPage();
		await t.db
			.update(mapInfo)
			.set({ name: `Evil "><script>alert(1)</script>` });
		const html = await (await t.app.request("/")).text();
		expect(html).not.toContain("<script>alert(1)");
		expect(meta(html, "og:title")).toContain("&quot;&gt;&lt;script&gt;");
	});

	test("unknown or invalid views keep the generic page", async () => {
		const t = bootPage();
		for (const q of ["?dim=nope", "?x=abc", "?zoom=NaN"]) {
			const html = await (await t.app.request(`/${q}`)).text();
			expect(html).toContain("<title>AOMC Map</title>");
			expect(html).not.toContain("og:");
		}
	});

	test("other pages (invite links, client routes) keep the generic page", async () => {
		const t = bootPage();
		for (const path of [
			"/invite/inv_abcdefghijklmnopqrstuvwxyz",
			"/anything/else",
		]) {
			const html = await (await t.app.request(path)).text();
			expect(html).toContain("<title>AOMC Map</title>");
			expect(html).not.toContain("og:");
		}
	});

	test("the page is not cached so edits to the map show up", async () => {
		const t = bootPage();
		expect((await t.app.request("/")).headers.get("cache-control")).toBe(
			"no-cache",
		);
	});

	test("a site without a built web app still serves the API", async () => {
		const t = makeTestApp({ WEB_DIST: join(tmpdir(), "aomc-missing-dist") });
		expect((await t.app.request("/")).status).toBe(404);
	});
});

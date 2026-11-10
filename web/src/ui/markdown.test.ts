import { describe, expect, test } from "bun:test";
import { parseInline, parseText, safeHref } from "./markdown";

describe("safeHref", () => {
	test("allows http and https only", () => {
		expect(safeHref("https://example.com/a?b=1")).toBe(
			"https://example.com/a?b=1",
		);
		expect(safeHref("http://example.com")).toBe("http://example.com/");
		for (const bad of [
			"javascript:alert(1)",
			"data:text/html,<b>",
			"ftp://x",
			"//evil.com",
			"not a url",
			"JaVaScRiPt:alert(1)",
		]) {
			expect(safeHref(bad)).toBeNull();
		}
	});
});

describe("parseInline", () => {
	test("plain text", () => {
		expect(parseInline("hello")).toEqual([{ kind: "text", text: "hello" }]);
	});

	test("bold and links mixed with text", () => {
		expect(parseInline("a **b** c [d](https://e.com) f")).toEqual([
			{ kind: "text", text: "a " },
			{ kind: "bold", text: "b" },
			{ kind: "text", text: " c " },
			{ kind: "link", text: "d", href: "https://e.com/" },
			{ kind: "text", text: " f" },
		]);
	});

	test("unsafe links stay as literal text", () => {
		expect(parseInline("[x](javascript:alert(1))")).toEqual([
			{ kind: "text", text: "[x](javascript:alert(1)" },
			{ kind: "text", text: ")" },
		]);
	});

	test("HTML is never interpreted: it is just text", () => {
		const out = parseInline('<img src=x onerror="alert(1)"> **hi**');
		expect(out[0]).toEqual({
			kind: "text",
			text: '<img src=x onerror="alert(1)"> ',
		});
		expect(out[1]).toEqual({ kind: "bold", text: "hi" });
	});

	test("unterminated markers are literal", () => {
		expect(parseInline("**oops")).toEqual([{ kind: "text", text: "**oops" }]);
		expect(parseInline("[a](")).toEqual([{ kind: "text", text: "[a](" }]);
	});
});

describe("parseText", () => {
	test("splits lines for <br>", () => {
		expect(parseText("a\r\nb\n\nc").map((l) => l.length)).toEqual([1, 1, 0, 1]);
	});
});

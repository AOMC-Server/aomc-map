import { describe, expect, test } from "bun:test";
import { formatBytes, formatEta } from "./format";

describe("formatBytes", () => {
	test("units", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.00 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
		expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GB");
		expect(formatBytes(150 * 1024)).toBe("150 KB");
	});
});

describe("formatEta", () => {
	test("seconds, then minutes, then hours", () => {
		expect(formatEta(0.2)).toBe("1 s");
		expect(formatEta(44.1)).toBe("45 s");
		expect(formatEta(200)).toBe("3 min 20 s");
		expect(formatEta(1500)).toBe("25 min");
		expect(formatEta(3900)).toBe("1 h 5 min");
	});
});

import { describe, expect, test } from "bun:test";
import { formatBytes } from "./format";

describe("formatBytes", () => {
	test("units", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.00 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
		expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GB");
		expect(formatBytes(150 * 1024)).toBe("150 KB");
	});
});

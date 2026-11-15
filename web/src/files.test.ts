import { describe, expect, test } from "bun:test";
import { fileUrl, numberedFileName, splitFilePath } from "@aomc/shared/files";
import { namesFromLocation, pathOfNames } from "./files";

describe("file library addresses", () => {
	test("folder names come from the address, decoded", () => {
		expect(namesFromLocation("/files")).toEqual([]);
		expect(namesFromLocation("/files/")).toEqual([]);
		expect(namesFromLocation("/files/voxy/World%201/")).toEqual([
			"voxy",
			"World 1",
		]);
		expect(namesFromLocation("/files/%E0%A4%A")).toEqual([]);
	});

	test("addresses and paths round-trip", () => {
		const names = ["voxy", "a b", "ü?#"];
		expect(namesFromLocation(fileUrl(names, true))).toEqual(names);
		expect(splitFilePath(pathOfNames(names))).toEqual(names);
		expect(fileUrl([], true)).toBe("/files/");
	});

	test("numbered names keep the extension", () => {
		expect(numberedFileName("world.zip", 2)).toBe("world (2).zip");
		expect(numberedFileName("README", 3)).toBe("README (3)");
		expect(numberedFileName(".hidden", 2)).toBe(".hidden (2)");
	});
});

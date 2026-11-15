import { describe, expect, test } from "bun:test";
import { fileUrl, numberedFileName, splitFilePath } from "@aomc/shared/files";
import {
	createSpeedMeter,
	namesFromLocation,
	pathOfNames,
	secondsLeft,
} from "./files";

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

describe("upload speed", () => {
	test("waits a second, then follows the speed smoothly", () => {
		const meter = createSpeedMeter(3000);
		meter.sample(0, 0);
		meter.sample(500_000, 500);
		expect(meter.speed(500)).toBeNull();
		meter.sample(1_000_000, 1000);
		expect(meter.speed(1000)).toBe(1_000_000);
		// A sudden stop pulls the estimate down, but not all the way at once.
		meter.sample(1_000_000, 2000);
		const after = meter.speed(2000) as number;
		expect(after).toBeLessThan(1_000_000);
		expect(after).toBeGreaterThan(500_000);
	});

	test("falls while nothing is reported", () => {
		const meter = createSpeedMeter(3000);
		meter.sample(0, 0);
		meter.sample(1_000_000, 1000);
		expect(meter.speed(1500)).toBe(1_000_000);
		expect(meter.speed(7000) as number).toBeLessThan(200_000);
	});

	test("ignores reports that come too close together", () => {
		const meter = createSpeedMeter();
		meter.sample(0, 0);
		meter.sample(1_000_000, 100);
		meter.sample(2_000_000, 1000);
		expect(meter.speed(1000)).toBe(2_000_000);
	});

	test("seconds left", () => {
		expect(secondsLeft(10_000_000, 1_000_000)).toBe(10);
		expect(secondsLeft(10, null)).toBeNull();
		expect(secondsLeft(10, 0)).toBeNull();
	});
});

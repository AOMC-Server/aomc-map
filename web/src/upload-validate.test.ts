import { describe, expect, test } from "bun:test";
import { exportDates, requestOverhead, validateFiles } from "./upload-validate";

const limits = {
	maxUploadBytes: 10_000,
	maxFilesPerUpload: 3,
	maxImageDim: 4096,
};

describe("validateFiles", () => {
	test("accepts named PNGs and zips", () => {
		const v = validateFiles(
			[
				{ name: "Overworld_x-512_z0.png", size: 100 },
				{ name: "export.ZIP", size: 200 },
			],
			limits,
		);
		expect(v.errors).toEqual([]);
		expect(v).toMatchObject({ pngCount: 1, zipCount: 1, totalBytes: 300 });
	});

	test("flags PNGs without coordinates and other file types", () => {
		const v = validateFiles(
			[
				{ name: "screenshot.png", size: 1 },
				{ name: "notes.txt", size: 1 },
			],
			limits,
		);
		expect(v.errors).toHaveLength(2);
		expect(v.errors[0]).toContain("screenshot.png");
		expect(v.errors[1]).toContain("notes.txt");
	});

	test("enforces the count and size limits", () => {
		const many = Array.from({ length: 4 }, (_, i) => ({
			name: `a_x${i}_z0.png`,
			size: 3000,
		}));
		const v = validateFiles(many, limits);
		expect(v.errors.some((e) => e.includes("Too many files"))).toBe(true);
		expect(v.errors.some((e) => e.includes("Too large"))).toBe(true);
	});
});

describe("request size", () => {
	test("counts the multipart overhead, not just the files", () => {
		const files = [{ name: "a_x0_z0.png", size: limits.maxUploadBytes - 100 }];
		expect(requestOverhead(files)).toBeGreaterThan(100);
		const v = validateFiles(files, limits);
		expect(v.errors.some((e) => e.includes("Too large"))).toBe(true);
		expect(v.totalBytes).toBe(files[0]?.size as number);
	});

	test("more files and longer paths cost more", () => {
		const one = [{ name: "a_x0_z0.png", size: 1 }];
		const two = [...one, { name: "b_x0_z0.png", size: 1 }];
		expect(requestOverhead(two)).toBeGreaterThan(requestOverhead(one));
		const deep = [{ ...one[0], path: `${"folder/".repeat(20)}a_x0_z0.png` }];
		expect(requestOverhead(deep as typeof one)).toBeGreaterThan(
			requestOverhead(one),
		);
	});

	test("rejects paths the server would not accept", () => {
		const long = { name: "a_x0_z0.png", size: 1, path: "d/".repeat(600) };
		const v = validateFiles([long], limits);
		expect(v.errors.some((e) => e.includes("path is too long"))).toBe(true);
	});
});

describe("exportDates", () => {
	test("reads dates from file names and folders, once per export", () => {
		const r = exportDates(
			[
				"2026-02-09_19.45.47_x-384_z-3776.png",
				"2026-02-10_15.06.41/0_0_x-1248_z-1472.png",
				"2026-02-10_15.06.41/0_1_x-1248_z-448.png",
				"2026-02-10_15.06.41.zip",
				"stray_x0_z0.png",
			],
			"UTC",
		);
		expect(r.dates).toEqual([
			Date.UTC(2026, 1, 9, 19, 45, 47),
			Date.UTC(2026, 1, 10, 15, 6, 41),
		]);
		expect(r.undated).toBe(1);
	});

	test("reads names in the given time zone", () => {
		const r = exportDates(["2026-07-01_12.00.00_x0_z0.png"], "Europe/Berlin");
		expect(r.dates).toEqual([Date.UTC(2026, 6, 1, 10)]);
	});

	test("no files, no dates", () => {
		expect(exportDates([])).toEqual({ dates: [], undated: 0 });
	});
});

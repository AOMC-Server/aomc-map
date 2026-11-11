import { describe, expect, test } from "bun:test";
import { fromFileList, wantedInFolder } from "./upload-files";

const file = (name: string, webkitRelativePath = "") =>
	({ name, webkitRelativePath }) as File;

describe("fromFileList", () => {
	test("a chosen folder skips hidden files and non-exports", () => {
		const items = fromFileList([
			file("a_x0_z0.png", "exp/a_x0_z0.png"),
			file(".DS_Store", "exp/.DS_Store"),
			file("notes.txt", "exp/notes.txt"),
			file("._a_x0_z0.png", "exp/._a_x0_z0.png"),
			file("b.zip", "exp/sub/b.zip"),
		]);
		expect(items.map((i) => i.path)).toEqual([
			"exp/a_x0_z0.png",
			"exp/sub/b.zip",
		]);
	});

	test("files picked one by one are all kept, so the validation can name them", () => {
		const items = fromFileList([file("notes.txt"), file("a_x0_z0.png")]);
		expect(items.map((i) => i.path)).toEqual(["notes.txt", "a_x0_z0.png"]);
	});
});

describe("wantedInFolder", () => {
	test("png and zip, not hidden", () => {
		expect(wantedInFolder("a.PNG")).toBe(true);
		expect(wantedInFolder("a.zip")).toBe(true);
		expect(wantedInFolder(".a.png")).toBe(false);
		expect(wantedInFolder("a.txt")).toBe(false);
	});
});

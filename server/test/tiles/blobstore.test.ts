import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createBlobStore, parseBlobName } from "../../src/tiles/blobstore";
import { cleanupTempDirs, makeTempDir } from "../helpers";

afterAll(cleanupTempDirs);

describe("blob store", () => {
	test("putting a blob that vanished after the exists check writes it again", async () => {
		const store = createBlobStore(makeTempDir("aomc-blobstore-"));
		const data = new Uint8Array([1, 2, 3]);
		const hash = await store.put(data);
		await rm(store.path(hash));

		const spy = spyOn(Bun, "file").mockImplementation(
			() => ({ exists: async () => true }) as never,
		);
		try {
			expect(await store.put(data)).toBe(hash);
		} finally {
			spy.mockRestore();
		}
		expect(existsSync(store.path(hash))).toBe(true);
	});
});

describe("blob names", () => {
	const h = "b".repeat(64);
	test("read the hash and format of <hash>.<suffix>", () => {
		expect(parseBlobName(`${h}.webp`)).toEqual({ hash: h, format: "webp" });
		expect(parseBlobName(`${h}.80.jpg`)).toEqual({ hash: h, format: "jpg-80" });
		expect(parseBlobName(`${h}.exe`)).toBeNull();
		expect(parseBlobName(`${h}-webp`)).toBeNull();
		expect(parseBlobName(`${"z".repeat(64)}.webp`)).toBeNull();
	});
});

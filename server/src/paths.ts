import { join } from "node:path";

/** Where the data directory keeps things. */
export const dbFile = (dataDir: string) => join(dataDir, "db.sqlite");
export const blobsDir = (dataDir: string) => join(dataDir, "blobs");
export const previewCacheDir = (dataDir: string) =>
	join(dataDir, "preview-cache");
/** Uploaded source files wait here, as `<revisionId>/<index>.png`, until processed. */
export const incomingRoot = (dataDir: string) => join(dataDir, "incoming");
/** Where `scripts/gc-blobs.ts` parks files it is about to delete. */
export const gcQuarantineDir = (dataDir: string) =>
	join(dataDir, "gc-quarantine");

import type { Db } from "../db/client";
import type { Env } from "../env";
import type { ProgressBus } from "../progress";
import type { BlobStore } from "../tiles/blobstore";

export type JobContext = {
	db: Db;
	env: Env;
	blobs: BlobStore;
	progress: ProgressBus;
};

export type UploadFile = {
	x: number;
	z: number;
	width: number;
	height: number;
};
export type ProcessUploadPayload = { revisionId: number; files: UploadFile[] };
export type ApplyRevertPayload = { revisionId: number; targetId: number };

/** Uploaded source files are stored as incoming/<revisionId>/<index>.png until processed. */
export const incomingDir = (env: Env, revisionId: number) =>
	`${env.DATA_DIR}/incoming/${revisionId}`;

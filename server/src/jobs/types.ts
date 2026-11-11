import { join } from "node:path";
import type { Db } from "../db/client";
import type { Env } from "../env";
import { incomingRoot } from "../paths";
import type { ProgressBus } from "../progress";
import type { BlobStore } from "../tiles/blobstore";

/** An error whose message is meant for the person who uploaded; any other error is only logged. */
export class UserError extends Error {}

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
/** Deletes the upload `revisionId` from the map and from all of its history. */
export type EraseUploadPayload = { revisionId: number };

/** Uploaded source files are stored as incoming/<revisionId>/<index>.png until processed. */
export const incomingDir = (env: Env, revisionId: number) =>
	join(incomingRoot(env.DATA_DIR), String(revisionId));

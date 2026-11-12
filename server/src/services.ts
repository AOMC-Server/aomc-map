import type { Db } from "./db/client";
import { blobFiles } from "./db/schema";
import type { Env } from "./env";
import { createEventHub } from "./events";
import { createWorker } from "./jobs/worker";
import { blobsDir, previewCacheDir } from "./paths";
import { createPreviewService } from "./preview";
import {
	createRateLimiter,
	PREVIEW_RATE_LIMIT,
	SHORT_LINK_RATE_LIMIT,
	WRITE_RATE_LIMIT,
} from "./ratelimit";
import { createBlobStore } from "./tiles/blobstore";
import { createTraffic } from "./traffic";

export type Services = ReturnType<typeof createServices>;

export function createServices(db: Db, env: Env) {
	const blobs = createBlobStore(blobsDir(env.DATA_DIR), (hash, bytes) => {
		db.insert(blobFiles).values({ hash, bytes }).onConflictDoNothing().run();
	});
	const events = createEventHub();
	const worker = createWorker({ db, env, blobs, events });
	const limiter = createRateLimiter(env.UPLOAD_RATE_LIMIT);
	const writeLimiter = createRateLimiter(WRITE_RATE_LIMIT);
	const previewLimiter = createRateLimiter(PREVIEW_RATE_LIMIT);
	const linkLimiter = createRateLimiter(SHORT_LINK_RATE_LIMIT);
	const preview = createPreviewService({
		cacheDir: previewCacheDir(env.DATA_DIR),
		maxCached: env.PREVIEW_CACHE_MAX,
	});
	const traffic = createTraffic(db, env);
	return {
		blobs,
		events,
		worker,
		limiter,
		writeLimiter,
		previewLimiter,
		linkLimiter,
		preview,
		traffic,
	};
}

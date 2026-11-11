import type { Db } from "./db/client";
import { blobFiles } from "./db/schema";
import type { Env } from "./env";
import { createWorker } from "./jobs/worker";
import { createPreviewService } from "./preview";
import { createProgressBus } from "./progress";
import {
	createRateLimiter,
	PREVIEW_RATE_LIMIT,
	WRITE_RATE_LIMIT,
} from "./ratelimit";
import { createBlobStore } from "./tiles/blobstore";
import { createTraffic } from "./traffic";

export type Services = ReturnType<typeof createServices>;

export function createServices(db: Db, env: Env) {
	const blobs = createBlobStore(`${env.DATA_DIR}/blobs`, (hash, bytes) => {
		db.insert(blobFiles).values({ hash, bytes }).onConflictDoNothing().run();
	});
	const progress = createProgressBus();
	const worker = createWorker({ db, env, blobs, progress });
	const limiter = createRateLimiter(env.UPLOAD_RATE_LIMIT);
	const writeLimiter = createRateLimiter(WRITE_RATE_LIMIT);
	const previewLimiter = createRateLimiter(PREVIEW_RATE_LIMIT);
	const preview = createPreviewService({
		cacheDir: `${env.DATA_DIR}/preview-cache`,
		maxCached: env.PREVIEW_CACHE_MAX,
	});
	const traffic = createTraffic(db, env);
	return {
		blobs,
		progress,
		worker,
		limiter,
		writeLimiter,
		previewLimiter,
		preview,
		traffic,
	};
}

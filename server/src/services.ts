import type { Db } from "./db/client";
import type { Env } from "./env";
import { createWorker } from "./jobs/worker";
import { createPreviewService } from "./preview";
import { createProgressBus } from "./progress";
import { createRateLimiter } from "./ratelimit";
import { createBlobStore } from "./tiles/blobstore";

export type Services = ReturnType<typeof createServices>;

export function createServices(db: Db, env: Env) {
	const blobs = createBlobStore(`${env.DATA_DIR}/blobs`);
	const progress = createProgressBus();
	const worker = createWorker({ db, env, blobs, progress });
	const limiter = createRateLimiter(env.UPLOAD_RATE_LIMIT);
	const preview = createPreviewService({
		cacheDir: `${env.DATA_DIR}/preview-cache`,
		maxCached: env.PREVIEW_CACHE_MAX,
	});
	return { blobs, progress, worker, limiter, preview };
}

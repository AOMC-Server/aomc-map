import { mkdirSync } from "node:fs";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { parseEnv } from "./env";
import { blobsDir, dbFile } from "./paths";
import { createServices } from "./services";
import { runSetup } from "./setup";
import { recordMissingBlobSizes, recordStorage } from "./storage";

const env = parseEnv();
mkdirSync(env.DATA_DIR, { recursive: true });

const db = createDb(dbFile(env.DATA_DIR));
runMigrations(db);
runSetup(db, env);

const services = createServices(db, env);
await recordMissingBlobSizes(db, blobsDir(env.DATA_DIR));
recordStorage(db, "boot");
services.traffic.start();
services.worker.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		services.worker.stop();
		services.traffic.stop();
		process.exit(0);
	});
}
const app = createApp({ db, env, services });

export default {
	port: env.PORT,
	fetch: app.fetch,
	maxRequestBodySize: env.MAX_UPLOAD_BYTES,
	idleTimeout: 60, // seconds; SSE pings every 20s keep progress streams open
};
console.log(`listening on :${env.PORT}`);

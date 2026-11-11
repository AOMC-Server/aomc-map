import { mkdirSync } from "node:fs";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { parseEnv } from "./env";
import { createServices } from "./services";
import { runSetup } from "./setup";

const env = parseEnv();
mkdirSync(env.DATA_DIR, { recursive: true });

const db = createDb(`${env.DATA_DIR}/db.sqlite`);
runMigrations(db);
runSetup(db, env);

const services = createServices(db, env);
services.worker.start();
const app = createApp({ db, env, services });

export default {
	port: env.PORT,
	fetch: app.fetch,
	maxRequestBodySize: env.MAX_UPLOAD_BYTES,
	idleTimeout: 60, // seconds; SSE pings every 20s keep progress streams open
};
console.log(`listening on :${env.PORT}`);

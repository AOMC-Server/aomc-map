import { mkdirSync } from "node:fs";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { parseEnv } from "./env";
import { runSetup } from "./setup";

const env = parseEnv();
mkdirSync(env.DATA_DIR, { recursive: true });

const db = createDb(`${env.DATA_DIR}/db.sqlite`);
runMigrations(db);
await runSetup(db, env);

const app = createApp({ db, env });

export default { port: env.PORT, fetch: app.fetch };
console.log(`listening on :${env.PORT}`);

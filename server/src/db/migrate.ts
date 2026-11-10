import { mkdirSync } from "node:fs";
import { parseEnv } from "../env";
import { createDb, runMigrations } from "./client";

const env = parseEnv();
mkdirSync(env.DATA_DIR, { recursive: true });
runMigrations(createDb(`${env.DATA_DIR}/db.sqlite`));
console.log("migrations applied");

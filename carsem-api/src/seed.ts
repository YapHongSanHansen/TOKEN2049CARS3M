/**
 *   npm run seed             idempotent
 *   npm run seed -- --reset  wipe the database first (stop the API before)
 */
import { rmSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { rootEnvPaths } from "@carsem/shared";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { seedDemo } from "./demo.js";

loadEnv({ path: rootEnvPaths(), quiet: true });
const config = loadConfig();
if (process.argv.includes("--reset") && config.dbPath !== ":memory:") {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${config.dbPath}${suffix}`, { force: true });
  console.log(`reset ${config.dbPath}`);
}
const db = new Db(config.dbPath);
seedDemo(db, config, { log: console.log });
db.close();
console.log("seed done");

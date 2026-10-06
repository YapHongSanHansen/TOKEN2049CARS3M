/**
 *   npm run seed             idempotent; also resets the demo agent to 0.05 tUSDM (simulated)
 *   npm run seed -- --reset  wipe the database first (stop the API before)
 */
import { rmSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { rootEnvPath } from "@carsem/shared";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { seedDemo } from "./demo.js";

loadEnv({ path: rootEnvPath(), quiet: true });
const config = loadConfig();
if (process.argv.includes("--reset") && config.dbPath !== ":memory:") {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${config.dbPath}${suffix}`, { force: true });
  console.log(`reset ${config.dbPath}`);
}
const db = new Db(config.dbPath);
seedDemo(db, config, { agentId: process.env.CARSEM_AGENT_ID?.trim() || "agent-demo", log: console.log });
db.close();
console.log("seed done");

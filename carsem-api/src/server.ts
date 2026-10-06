import { config as loadEnv } from "dotenv";
import { rootEnvPaths } from "@carsem/shared";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

loadEnv({ path: rootEnvPaths(), quiet: true });
const config = loadConfig();
const { app, ctx } = await createApp(config);

// Loan deadlines are enforced continuously so the default path shows up live.
setInterval(() => {
  try { ctx.lending.checkDefaults(); } catch (error) { console.error("[lending] default check failed", error); }
}, config.defaultCheckIntervalMs).unref();

app.listen(config.port, () => {
  console.log(`CARSEM API  ${config.publicUrl}  (${config.mode}${config.mode === "preprod" ? `, facilitator ${config.preprod.facilitatorUrl}` : ", built-in simulated facilitator"})`);
  console.log(`treasury    ${ctx.chain.treasuryAddress}`);
  if (!ctx.db.get("SELECT 1 FROM listings LIMIT 1")) console.log("No platform data yet. Run: npm run seed");
});

/**
 * npm run ask -- "Find me trading signals on CARSEM…" [--outcome win|loss] [--brain openai|scripted]
 * The same as: curl -N <gateway>/v1/ask -H "Authorization: Bearer $CARSEM_KEY" -d '{"message":"…"}'
 */
import { loadGatewayConfig } from "./config.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); if (i === -1) return undefined; const [, v] = args.splice(i, 2); return v; };
const forceOutcome = flag("outcome");
const brain = flag("brain");
const message = args.join(" ").trim() || "Find me the information of trading signals on CARSEM, I would like to make some pocket money on Cardano DEX trades.";
const config = loadGatewayConfig();
const key = process.env.CARSEM_KEY?.trim();
if (!key) { console.error("Set CARSEM_KEY (from onboarding, or npm run demo:user) in .env.local or the shell."); process.exit(1); }

const response = await fetch(`${config.publicUrl}/v1/ask`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ message, forceOutcome, brain }),
});
if (!response.ok || !response.body) { console.error(await response.text()); process.exit(1); }
for await (const chunk of response.body) process.stdout.write(Buffer.from(chunk));

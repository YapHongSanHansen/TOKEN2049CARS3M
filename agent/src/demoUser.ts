/**
 * npm run demo:user -- [--name "Alice"] [--doc A12345678] [--country MY] [--save]
 * Walks the onboarding gate against the running API + gateway (start → mock KYC →
 * consent → complete), syncs a few sample chats like the ones in the drawing, and
 * prints the CARSEM key plus the commands to connect Hermes / Claude Code / curl.
 * --save writes CARSEM_KEY into .env.local.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { repoRoot } from "@carsem/shared";
import { api } from "./api.js";
import { loadGatewayConfig } from "./config.js";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const config = loadGatewayConfig();
const name = option("name") ?? "Alice";
const SAMPLE_CHATS = [
  "Cheapest flight from Kuala Lumpur to Singapore next weekend",
  "Cheapest Pokemon Pack 30th Anniversary",
  "Cheapest hotel at Singapore Geylang for 2 nights",
  "My girlfriend's birthday is on 30th Sept, what should I buy? Budget around RM 300",
  "Find me the information of trading signals, I want some extra pocket money on Cardano DEX trades",
];

const { apiKey } = await api<{ apiKey: string }>(config.apiUrl, "/onboarding/start", { body: { name } });
const auth = { Authorization: `Bearer ${apiKey}` };
await api(config.apiUrl, "/onboarding/kyc", { body: { fullName: name, documentNumber: option("doc") ?? `DEMO${randomBytes(4).toString("hex").toUpperCase()}`, country: option("country") ?? "MY" }, headers: auth });
await api(config.apiUrl, "/onboarding/consent", { body: { allowBorrowing: true, allowSaleWhileOpen: true }, headers: auth });
const profile = await api<any>(config.apiUrl, "/onboarding/complete", { body: {}, headers: auth });
const synced = await api<any>(config.apiUrl, "/me/sync", { body: { source: "assistant", items: SAMPLE_CHATS }, headers: auth });

console.log(`\n${name} is onboarded (mock KYC).`);
console.log(`  DID          ${profile.identity.did}`);
console.log(`  agent DID    ${profile.agent.did}`);
console.log(`  agent wallet ${profile.agent.address}`);
console.log(`  synced       ${synced.items} redacted items (ready to borrow: ${synced.readyToBorrow})`);
console.log(`\nCARSEM_KEY=${apiKey}\n`);
console.log("Connect your AI:");
console.log(`  curl     curl -N ${config.publicUrl}/v1/ask -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"message":"Find me trading signals on CARSEM"}'`);
console.log(`  Claude   claude mcp add --transport http carsem ${config.publicUrl}/mcp --header "Authorization: Bearer ${apiKey}"`);
console.log(`  Hermes   (profile carsem, config.yaml)\n           mcp_servers:\n             carsem:\n               url: ${config.publicUrl}/mcp\n               headers:\n                 Authorization: "Bearer ${apiKey}"`);
console.log(`  ChatGPT / Claude web: custom connector URL ${config.publicUrl}/mcp/k/${apiKey}   (needs a public URL)`);

if (args.includes("--save")) {
  const path = join(repoRoot(), ".env.local");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, /^CARSEM_KEY=.*$/m.test(current) ? current.replace(/^CARSEM_KEY=.*$/m, `CARSEM_KEY=${apiKey}`) : `${current.trimEnd()}\nCARSEM_KEY=${apiKey}\n`);
  console.log(`\nSaved CARSEM_KEY to ${path}`);
}

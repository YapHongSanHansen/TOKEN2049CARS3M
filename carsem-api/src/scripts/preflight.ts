/**
 * npm run preflight
 * Checks everything a live preprod run needs, and says how to fix what is missing.
 */
import { config as loadEnv } from "dotenv";
import { toClientCardanoSigner } from "@x402/cardano";
import { LOVELACE, NETWORK, fromUnits, rootEnvPath, toUnits } from "@carsem/shared";

loadEnv({ path: rootEnvPath(), quiet: true });
const env = (name: string) => process.env[name]?.trim() ?? "";
let failures = 0;
const ok = (line: string) => console.log(`  ✔ ${line}`);
const fail = (line: string, fix: string) => { failures++; console.log(`  ✖ ${line}\n      → ${fix}`); };

const projectId = env("BLOCKFROST_PROJECT_ID");
const baseUrl = (env("BLOCKFROST_BASE_URL") || "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/$/, "");
const usdm = env("USDM_ASSET") || "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d";
const facilitator = (env("FACILITATOR_URL") || "http://localhost:4022").replace(/\/$/, "");

console.log("\nConfiguration");
env("CHAIN_MODE") === "preprod" ? ok("CHAIN_MODE=preprod") : fail(`CHAIN_MODE=${env("CHAIN_MODE") || "simulated"}`, "set CHAIN_MODE=preprod in .env");
/^[0-9a-fA-F]{64}$/.test(env("BUNDLE_KEY")) ? ok("BUNDLE_KEY set") : fail("BUNDLE_KEY missing", "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" and put it in .env");
env("ANTHROPIC_API_KEY") ? ok("ANTHROPIC_API_KEY set (Claude brain)") : console.log("  · ANTHROPIC_API_KEY not set: the scripted brain will run");

console.log("\nBlockfrost");
let blockfrostOk = false;
if (!projectId.startsWith("preprod")) fail("BLOCKFROST_PROJECT_ID is not a preprod project id", "create a Cardano preprod project at https://blockfrost.io");
else {
  const response = await fetch(`${baseUrl}/blocks/latest`, { headers: { project_id: projectId } }).catch(() => undefined);
  if (response?.ok) { blockfrostOk = true; ok(`preprod tip: block ${(await response.json() as { height: number }).height}`); }
  else fail(`Blockfrost answered ${response?.status ?? "nothing"}`, "check the project id and network");
}

console.log("\nFacilitator");
try {
  const supported = await (await fetch(`${facilitator}/supported`, { signal: AbortSignal.timeout(5000) })).json() as { kinds: Array<{ x402Version: number; scheme: string; network: string }> };
  supported.kinds.some(k => k.x402Version === 2 && k.scheme === "exact" && k.network === NETWORK) ? ok(`${facilitator} serves exact on ${NETWORK}`) : fail(`${facilitator} does not serve ${NETWORK}`, "check its X402_NETWORK_ID");
} catch {
  fail(`no facilitator at ${facilitator}`, "start Docker Desktop, then npm run facilitator:up");
}

console.log("\nWallets");
const needs: Array<[string, string, bigint, bigint, bigint?]> = [
  ["TREASURY_MNEMONIC", "treasury", toUnits("20"), toUnits("10")],
  ["AGENT_MNEMONIC", "agent", toUnits("10"), 0n, toUnits("1")],
  ["ENTERPRISE_MNEMONIC", "enterprise", toUnits("5"), toUnits("5")],
];
for (const [name, label, minAda, minUsdm, maxUsdm] of needs) {
  const mnemonic = env(name);
  if (mnemonic.split(/\s+/).length < 12) { fail(`${name} missing`, "npm run wallets:new"); continue; }
  const address = toClientCardanoSigner({ mnemonic, network: NETWORK, provider: { blockfrost: { baseUrl, projectId } } }).getAddress();
  if (!blockfrostOk) { console.log(`  · ${label} ${address} (balance not checked)`); continue; }
  const response = await fetch(`${baseUrl}/addresses/${address}`, { headers: { project_id: projectId } });
  const amounts = response.status === 404 ? [] : (await response.json() as { amount: Array<{ unit: string; quantity: string }> }).amount;
  const of = (unit: string) => BigInt(amounts.find(a => a.unit === unit)?.quantity ?? "0");
  const ada = of(LOVELACE);
  const tusdm = of(usdm.replace(".", ""));
  const summary = `${label.padEnd(10)} ${fromUnits(ada)} tADA, ${fromUnits(tusdm)} tUSDM  ${address}`;
  if (ada < minAda) fail(summary, `send ≥ ${fromUnits(minAda)} tADA from https://docs.cardano.org/cardano-testnets/tools/faucet`);
  else if (tusdm < minUsdm) fail(summary, `send ≥ ${fromUnits(minUsdm)} tUSDM from https://dispenser.masumi.network`);
  else if (maxUsdm !== undefined && tusdm > maxUsdm) fail(summary, "for the demo the agent should start nearly empty (0.05 tUSDM); move the rest out");
  else ok(summary);
}

console.log(failures ? `\n${failures} problem(s) to fix before a live run.\n` : "\nReady for preprod: npm run seed -- --reset && npm run demo\n");
process.exitCode = failures ? 1 : 0;

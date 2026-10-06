/**
 * npm run wallets:new
 * Creates preprod test wallets for TREASURY_MNEMONIC, AGENT_MNEMONIC and
 * ENTERPRISE_MNEMONIC in the repo's .env (only where empty) and prints the
 * addresses to fund. Mnemonics are written to .env, never printed.
 * Testnet only: never put real funds on these.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { toClientCardanoSigner } from "@x402/cardano";
import { repoRoot } from "@carsem/shared";

const envPath = join(repoRoot(), ".env");
if (!existsSync(envPath)) throw new Error("Create .env first: cp .env.example .env");
let env = readFileSync(envPath, "utf8");
const read = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1]?.trim() ?? "";
const write = (name: string, value: string) => {
  env = new RegExp(`^${name}=`, "m").test(env) ? env.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`;
};

const roles = [
  ["TREASURY_MNEMONIC", "treasury (lender + seller)", "~50 tADA and the tUSDM you will lend, e.g. 20"],
  ["AGENT_MNEMONIC", "agent", "~20 tADA and exactly 0.05 tUSDM"],
  ["ENTERPRISE_MNEMONIC", "enterprise buyer", "~10 tADA and 30+ tUSDM"],
] as const;

console.log("Fund these preprod addresses:\n");
for (const [name, label, funding] of roles) {
  let mnemonic = read(name);
  const created = !mnemonic;
  if (created) { mnemonic = generateMnemonic(wordlist, 256); write(name, mnemonic); }
  const blockfrost = { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: read("BLOCKFROST_PROJECT_ID") };
  const address = toClientCardanoSigner({ mnemonic, network: "cardano:preprod", provider: { blockfrost } }).getAddress();
  console.log(`${label.padEnd(26)} ${created ? "(new)     " : "(existing)"} ${address}\n${" ".repeat(38)}fund: ${funding}\n`);
}
writeFileSync(envPath, env);
console.log("tADA:  https://docs.cardano.org/cardano-testnets/tools/faucet  (Preprod)");
console.log("tUSDM: https://dispenser.masumi.network  (policy 16a55b2a…)");
console.log("\nThen: npm run preflight");

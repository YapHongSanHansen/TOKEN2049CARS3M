/**
 * npm run wallets:new
 * Creates the platform's preprod wallets in .env.local (only where empty) and
 * prints the addresses to fund. Users' agent wallets are NOT here: the gateway
 * creates and holds one per verified user, funded from the treasury.
 * Mnemonics are written to .env.local (gitignored), never printed. Testnet only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { toClientCardanoSigner } from "@x402/cardano";
import { repoRoot } from "@carsem/shared";

const envPath = join(repoRoot(), ".env.local");
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const read = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1]?.trim() ?? "";
const write = (name: string, value: string) => {
  env = new RegExp(`^${name}=`, "m").test(env) ? env.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`;
};

const roles = [
  ["TREASURY_MNEMONIC", "treasury (lender + seller)", "~200 tADA (fees + 5 tADA starter per user) and 50+ tUSDM (loans + 0.05 starter per user)"],
  ["ENTERPRISE_MNEMONIC", "enterprise buyer (demo)", "~10 tADA and 50+ tUSDM"],
] as const;

console.log("Fund these preprod addresses:\n");
for (const [name, label, funding] of roles) {
  let mnemonic = read(name);
  const created = !mnemonic;
  if (created) { mnemonic = generateMnemonic(wordlist, 256); write(name, mnemonic); }
  const address = toClientCardanoSigner({ mnemonic, network: "cardano:preprod", provider: { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: read("BLOCKFROST_PROJECT_ID") } } }).getAddress();
  console.log(`${label.padEnd(26)} ${created ? "(new)     " : "(existing)"} ${address}\n${" ".repeat(38)}fund: ${funding}\n`);
}
writeFileSync(envPath, env);
console.log("tADA:  https://docs.cardano.org/cardano-testnets/tools/faucet  (Preprod)");
console.log("tUSDM: https://dispenser.masumi.network  (policy 16a55b2a…)");
console.log("\nThen: npm run preflight");

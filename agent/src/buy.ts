/**
 * npm run agent:buy [-- TOKEN] [--topup]
 * Buys one signal over x402 with no browser and no LLM (build plan step 5).
 * --topup (simulated mode only) mints the shortfall into the agent wallet first.
 */
import { fromUnits } from "@carsem/shared";
import { api } from "./api.js";
import { loadAgentConfig } from "./config.js";
import { printEvent } from "./log.js";
import { AgentTools } from "./tools.js";
import { agentWallet } from "./wallet.js";

const args = process.argv.slice(2);
const topup = args.includes("--topup");
const token = args.find(a => !a.startsWith("--")) ?? "MIN";
const config = loadAgentConfig();
const wallet = agentWallet(config);
const tools = new AgentTools(config, wallet, printEvent);
console.log(`agent ${wallet.address} (${config.mode}) buying a ${token} signal`);

let result = await tools.getSignal({ token });
if (!("error" in result) && result.status === "insufficient_funds") {
  if (topup && config.mode === "simulated") {
    await api(config.apiUrl, "/sim/faucet", { body: { address: wallet.address, usdm: result.shortfall_usdm } });
    console.log(`topped up ${result.shortfall_usdm} tUSDM (simulated faucet)`);
    result = await tools.getSignal({ token });
  } else {
    console.log(`\nNot enough tUSDM: need ${result.price_usdm}, have ${result.balance_usdm}. ${config.mode === "simulated" ? "Re-run with --topup." : `Send ${result.shortfall_usdm} tUSDM to ${wallet.address}.`}`);
    process.exit(1);
  }
}
if ("error" in result || result.status !== "delivered") {
  console.error("\npurchase failed:", result);
  process.exit(1);
}
const { usdmAsset } = await tools.service();
const balances = await wallet.balances();
console.log(`\nbought ${result.signal.direction} ${result.signal.pair} (confidence ${result.signal.confidence})`);
console.log(`payment   ${result.payment_tx}  ${result.payment_explorer}`);
console.log(`delivery  ${result.delivery_hash}`);
console.log(`balance   ${fromUnits(balances[usdmAsset] ?? 0n)} tUSDM`);

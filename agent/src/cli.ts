/**
 * npm run agent -- "Get me a trading signal for MIN and trade it"
 *   --brain claude|scripted   (default: claude when an Anthropic credential is set)
 *   --outcome win|loss        force the simulated DEX outcome (demo green / red path)
 */
import { runAgent, type Brain } from "./brain.js";
import { loadAgentConfig } from "./config.js";
import { printEvent } from "./log.js";
import { agentWallet } from "./wallet.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
};
const brain = flag("brain") as Brain | undefined;
const outcome = flag("outcome") as "win" | "loss" | undefined;
if (brain && brain !== "claude" && brain !== "scripted") throw new Error("--brain must be claude or scripted");
if (outcome && outcome !== "win" && outcome !== "loss") throw new Error("--outcome must be win or loss");
const message = args.join(" ").trim() || "Get me a trading signal for MIN and trade it.";

const config = loadAgentConfig();
const wallet = agentWallet(config);
console.log(`agent ${config.agentId}  ${wallet.address}  (${config.mode})`);
try {
  await runAgent(message, { config, wallet, emit: printEvent, brain, forceOutcome: outcome });
} catch {
  process.exitCode = 1;
}

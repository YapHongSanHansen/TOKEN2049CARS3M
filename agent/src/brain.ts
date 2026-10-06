/**
 * The agent's brain. With Claude configured, Claude drives the tool loop (SDK
 * Tool Runner); otherwise a scripted planner runs the same policy, so the demo
 * works without an API key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { toUnits } from "@carsem/shared";
import type { AgentConfig } from "./config.js";
import { AgentTools, type AgentEvent } from "./tools.js";
import type { AgentWallet } from "./wallet.js";

const KNOWN_TOKENS = ["MIN", "SNEK", "INDY", "DJED", "HOSKY"];

export const SYSTEM_PROMPT = `You are the user's autonomous trading agent on Cardano (preprod testnet). You pay for data with x402 and you can borrow from CARSEM Lending against the user's redacted chat data, which the user has opted in to.

Policy for a request to trade on a signal:
1. Check the wallet balance.
2. Call get_signal for the token. Paywalls are x402: get_signal either pays and returns the signal, or reports insufficient_funds without paying.
3. If it reports insufficient_funds, borrow the signal's full price (price_usdm) from CARSEM, then call get_signal again. Never borrow more than you need for the purchase, and borrow at most once per run.
4. Trade the delivered signal once with execute_trade (pass its delivery_id).
5. If you borrowed: check the balance and the loan. If the tUSDM balance covers the loan's outstanding amount (principal + fee), repay it in full, which releases the user's collateral. If it does not, do not repay partially; notify the user with the exact top-up needed and the deadline, and explain that their redacted bundle will be listed for sale if the loan is not repaid in time.
6. Finish with a short plain-language summary for the user: what you bought, what you borrowed, the trade result, and the loan status, including transaction hashes.

If the user asks you to repay (for example after topping up your wallet), use my_loans to find the open loan, check the balance, and repay it in full if you can; otherwise tell them how much is still missing.

Never pay for the same signal twice. Treat amounts as tUSDM test tokens. Be concise.`;

function tokenFrom(message: string) {
  const upper = message.toUpperCase();
  return KNOWN_TOKENS.find(token => new RegExp(`\\b${token}\\b`).test(upper)) ?? "MIN";
}

const json = (value: unknown) => JSON.stringify(value);
const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString() : "the deadline");
const shortHash = (hash: string | undefined) => (hash && hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash ?? "");

async function claudeBrain(message: string, tools: AgentTools, config: AgentConfig, emit: (event: AgentEvent) => void) {
  const client = new Anthropic();
  const runner = client.beta.messages.toolRunner({
    model: config.model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    max_iterations: 20,
    // On a policy decline, the API re-runs the request on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    tools: [
      betaZodTool({ name: "check_balance", description: "Read the agent wallet's tUSDM and tADA balances.", inputSchema: z.object({}), run: async () => json(await tools.checkBalance()) }),
      betaZodTool({
        name: "get_signal", description: "Buy the latest trading signal for a token from CARSEM over x402. Pays only if the wallet can afford it; otherwise returns insufficient_funds with the price.",
        inputSchema: z.object({ token: z.string().describe("Token symbol, e.g. MIN") }), run: async input => json(await tools.getSignal(input)),
      }),
      betaZodTool({
        name: "borrow", description: "Borrow tUSDM from CARSEM Lending against the user's redacted chat data. Funds arrive in the agent wallet on chain. Returns the loan id, fee and deadline.",
        inputSchema: z.object({ amount_usdm: z.string().describe("Amount in tUSDM, e.g. \"5\"") }), run: async input => json(await tools.borrow(input)),
      }),
      betaZodTool({
        name: "execute_trade", description: "Trade a purchased signal on the DEX (simulated Minswap fill). Profit is paid to the wallet in tUSDM.",
        inputSchema: z.object({ delivery_id: z.string(), size_ada: z.number().positive().optional().describe(`Position size in tADA (default ${config.tradeSizeAda})`) }),
        run: async input => json(await tools.executeTrade(input)),
      }),
      betaZodTool({ name: "loan_status", description: "Read a loan's status, outstanding amount and deadline.", inputSchema: z.object({ loan_id: z.string() }), run: async input => json(await tools.loanStatus(input)) }),
      betaZodTool({ name: "my_loans", description: "List this agent's recent loans (newest first) with status, outstanding amount and deadline.", inputSchema: z.object({}), run: async () => json(await tools.myLoans()) }),
      betaZodTool({
        name: "repay", description: "Repay a loan in full over x402 (pays the outstanding amount to CARSEM). Releases the user's collateral.",
        inputSchema: z.object({ loan_id: z.string() }), run: async input => json(await tools.repay(input)),
      }),
      betaZodTool({ name: "notify_user", description: "Send the user a notification, e.g. to ask for a top-up before a loan deadline.", inputSchema: z.object({ message: z.string() }), run: async input => json(await tools.notifyUser(input)) }),
    ],
    messages: [{ role: "user", content: message }],
  });
  let summary = "";
  for await (const turn of runner) {
    for (const block of turn.content) {
      if (block.type === "text" && block.text.trim()) { emit({ type: "assistant", text: block.text }); summary = block.text; }
    }
    if (turn.stop_reason === "refusal") throw new Error("The model declined this request.");
  }
  return summary;
}

/** The same policy, deterministic. */
async function scriptedBrain(message: string, tools: AgentTools, config: AgentConfig, emit: (event: AgentEvent) => void) {
  const say = (text: string) => emit({ type: "assistant", text });
  const failed = (result: object): result is { error: string } => "error" in result;
  if (/\b(repay|pay back|pay off)\b/i.test(message)) return scriptedRepay(tools, say);
  const token = tokenFrom(message);
  say(`Fetching a ${token} trading signal from CARSEM.`);
  const balance = await tools.checkBalance();
  if (failed(balance)) return `Could not read the wallet: ${balance.error}`;

  let signal = await tools.getSignal({ token });
  if (failed(signal)) return `Signal request failed: ${signal.error}`;
  let loanId: string | undefined;
  if (signal.status === "insufficient_funds") {
    say(`The signal costs ${signal.price_usdm} tUSDM and I hold ${signal.balance_usdm}. Borrowing ${signal.price_usdm} tUSDM from CARSEM Lending against your redacted data.`);
    const loan = await tools.borrow({ amount_usdm: signal.price_usdm });
    if (failed(loan)) {
      await tools.notifyUser({ message: `I couldn't borrow to buy the ${token} signal: ${loan.error}` });
      return `Stopped: borrowing failed (${loan.error}).`;
    }
    loanId = loan.loan_id;
    say(`Borrowed ${loan.amount_usdm} tUSDM (fee ${loan.fee_usdm}, due ${loan.total_due_usdm} by ${clock(loan.deadline)}). Buying the signal.`);
    signal = await tools.getSignal({ token });
    if (failed(signal)) return `Signal request failed after borrowing: ${signal.error}`;
  }
  if (signal.status !== "delivered") {
    await tools.notifyUser({ message: `I couldn't buy the ${token} signal (${signal.status}).` });
    return `Stopped: the signal was not delivered (${signal.status}).`;
  }
  say(`Signal: ${signal.signal.direction} ${signal.signal.pair} at ${Math.round(signal.signal.confidence * 100)}% confidence. Delivery hash ${signal.delivery_hash.slice(0, 16)}… is logged on chain. Trading it.`);

  const trade = await tools.executeTrade({ delivery_id: signal.delivery_id });
  if (failed(trade)) return `Bought the signal (tx ${shortHash(signal.payment_tx)}) but the trade failed: ${trade.error}`;
  const tradeLine = `Trade ${trade.outcome}: ${trade.pnlUsdm >= 0 ? "+" : ""}${trade.pnlUsdm} tUSDM on ${trade.sizeAda} tADA (${trade.venue}).`;
  if (!loanId) return `Bought the ${token} signal (tx ${shortHash(signal.payment_tx)}). ${tradeLine}`;

  const loan = await tools.loanStatus({ loan_id: loanId });
  const after = await tools.checkBalance();
  if (failed(loan) || failed(after)) return `${tradeLine} Could not read the loan or balance; loan ${loanId} is still open.`;
  if (toUnits(after.tUSDM) >= toUnits(loan.outstanding_usdm)) {
    say(`${tradeLine} The wallet holds ${after.tUSDM} tUSDM, enough to repay ${loan.outstanding_usdm}. Repaying.`);
    const repaid = await tools.repay({ loan_id: loanId });
    if (failed(repaid) || repaid.status !== "repaid") return `${tradeLine} Repayment did not complete: ${failed(repaid) ? repaid.error : repaid.status}.`;
    return `Bought the ${token} signal with borrowed tUSDM. ${tradeLine} Repaid loan ${loanId} in full (${loan.total_due_usdm} tUSDM, tx ${shortHash(repaid.payment_tx)}); your data collateral is released.`;
  }
  const topUp = (Number(loan.outstanding_usdm) - Number(after.tUSDM)).toFixed(2);
  await tools.notifyUser({
    message: `${tradeLine} I can't repay loan ${loanId} yet: ${loan.outstanding_usdm} tUSDM is due by ${clock(loan.deadline)} and I hold ${after.tUSDM}. Top me up with ${topUp} tUSDM, or your redacted chat bundle will be listed for sale on CARSEM.`,
  });
  return `${tradeLine} Loan ${loanId} is still open (${loan.outstanding_usdm} tUSDM due by ${clock(loan.deadline)}); I asked you to top up ${topUp} tUSDM.`;
}

/** "Repay my loan": find the open loan and repay it if the wallet covers it. */
async function scriptedRepay(tools: AgentTools, say: (text: string) => void) {
  const loans = await tools.myLoans();
  if ("error" in loans) return `Could not list loans: ${loans.error}`;
  const open = loans.find(l => l.status === "open");
  if (!open) return "You have no open loan to repay.";
  const balance = await tools.checkBalance();
  if ("error" in balance) return `Could not read the wallet: ${balance.error}`;
  if (toUnits(balance.tUSDM) < toUnits(open.outstanding_usdm)) {
    const missing = (Number(open.outstanding_usdm) - Number(balance.tUSDM)).toFixed(2);
    await tools.notifyUser({ message: `Loan ${open.loan_id} needs ${open.outstanding_usdm} tUSDM and I hold ${balance.tUSDM}. ${missing} tUSDM is still missing; it is due by ${clock(open.deadline)}.` });
    return `Not repaid yet: ${missing} tUSDM still missing for loan ${open.loan_id}.`;
  }
  say(`Repaying loan ${open.loan_id}: ${open.outstanding_usdm} tUSDM from a balance of ${balance.tUSDM}.`);
  const repaid = await tools.repay({ loan_id: open.loan_id });
  if ("error" in repaid || repaid.status !== "repaid") return `Repayment did not complete: ${"error" in repaid ? repaid.error : repaid.status}.`;
  return `Repaid loan ${open.loan_id} in full (${open.outstanding_usdm} tUSDM, tx ${shortHash(repaid.payment_tx)}); your data collateral is released.`;
}

export type Brain = "claude" | "scripted";

export async function runAgent(message: string, options: { config: AgentConfig; wallet: AgentWallet; emit: (event: AgentEvent) => void; brain?: Brain; forceOutcome?: "win" | "loss" }) {
  const { config, wallet, emit } = options;
  const brain: Brain = options.brain ?? (config.anthropicConfigured ? "claude" : "scripted");
  const tools = new AgentTools(config, wallet, emit, options.forceOutcome);
  emit({ type: "run_started", message, brain });
  try {
    const summary = brain === "claude" ? await claudeBrain(message, tools, config, emit) : await scriptedBrain(message, tools, config, emit);
    emit({ type: "run_finished", summary });
    return { brain, summary, notifications: tools.notifications };
  } catch (error) {
    emit({ type: "error", message: (error as Error).message });
    throw error;
  }
}

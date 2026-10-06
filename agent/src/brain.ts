/**
 * The built-in brain behind `curl /v1/ask`. Hermes, Claude Code, ChatGPT and
 * Claude bring their own brain over MCP; this one is for plain curl.
 *   OpenAI (OPENAI_API_KEY + OPENAI_MODEL)  function calling over the same tools
 *   scripted (no key)                       the same workflow, deterministic
 */
import OpenAI from "openai";
import { z } from "zod";
import { toUnits } from "@carsem/shared";
import type { GatewayConfig } from "./config.js";
import { checkUi, toAgent, ui, uiPrompt, type UiCode } from "@carsem/shared/genui";
import { findTool, TOOLS, WORKFLOW } from "./toolDefs.js";
import type { AgentEvent, UserAgent } from "./tools.js";

export type Brain = "openai" | "scripted";
const KNOWN_TOKENS = ["MIN", "SNEK", "INDY", "DJED", "HOSKY"];
const failed = (result: unknown): result is { error: string } => !!result && typeof result === "object" && "error" in result;
const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString() : "the deadline");
const short = (hash: string | undefined) => (hash && hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash ?? "");

/** Emits a UI program if it is valid; a bad program is logged and skipped (the text still tells the story). */
function showUi(emit: (e: AgentEvent) => void, children: UiCode[]) {
  const code = ui.stack(children);
  const check = checkUi(code);
  if (check.ok) emit({ type: "ui", code });
  else console.warn("[brain] invalid UI skipped:", check.errors.join("; "), "\n", code);
}
/** The rows a DataCard shows for a listing's data. */
function dataRows(category: string, data: Record<string, unknown>): Array<{ label: string; value: string }> {
  const s = (v: unknown) => String(v ?? "");
  const rows: Array<[string, string]> =
    category === "signal" ? [["Direction", s(data.direction).toUpperCase()], ["Confidence", `${Math.round(Number(data.confidence) * 100)}%`], ["Horizon", `${s(data.horizonMinutes)} min`], ["Why", s(data.rationale)]]
    : category === "flight" ? [["Flight", `${s(data.airline)} ${s(data.flight)}`], ["Date", s(data.date)], ["Fare", `${s(data.currency)} ${s(data.price)}`]]
    : category === "hotel" ? [["Hotel", s(data.name)], ["Area", s(data.area)], ["Per night", `${s(data.currency)} ${s(data.pricePerNight)}`], ["Rating", `${s(data.rating)} / 5`]]
    : [["Store", s(data.store)], ["Price", `${s(data.currency)} ${s(data.price)}`], ...(data.note ? [["Note", s(data.note)] as [string, string]] : [])];
  return rows.map(([label, value]) => ({ label, value }));
}
/** OpenAI replies may carry a ```openui block: it becomes a UI event and the prose stays text. */
function splitUi(content: string): { text: string; code?: string } {
  const match = /```(?:openui|openui-lang)?\s*\n([\s\S]*?)```/i.exec(content);
  if (!match || !/^\s*\w+\s*=\s*[A-Z]\w*\(/m.test(match[1])) return { text: content };
  return { text: content.replace(match[0], "").trim(), code: match[1].trim() };
}

async function openaiBrain(message: string, agent: UserAgent, config: GatewayConfig, emit: (e: AgentEvent) => void) {
  if (!config.openai.model) throw new Error("Set OPENAI_MODEL (a model your key can use with function calling) to use the OpenAI brain.");
  const client = new OpenAI({ apiKey: config.openai.apiKey });
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map(tool => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: `${WORKFLOW}\n\n${uiPrompt()}` }, { role: "user", content: message }];
  let summary = "";
  for (let turn = 0; turn < 24; turn++) {
    const completion = await client.chat.completions.create({ model: config.openai.model, messages, tools });
    const reply = completion.choices[0]?.message;
    if (!reply) break;
    messages.push(reply);
    if (reply.content?.trim()) {
      const { text, code } = splitUi(reply.content);
      summary = text || summary;
      if (code && checkUi(code).ok) emit({ type: "ui", code });
      if (text) emit({ type: "assistant", text });
    }
    const calls = (reply.tool_calls ?? []).filter(call => call.type === "function");
    if (!calls.length) break;
    for (const call of calls) {
      const tool = findTool(call.function.name);
      let output: unknown;
      try { output = tool ? await tool.run(agent, tool.input.parse(JSON.parse(call.function.arguments || "{}"))) : { error: `Unknown tool ${call.function.name}` }; }
      catch (error) { output = { error: (error as Error).message }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  return summary;
}

function intentOf(message: string): { category: "signal" | "flight" | "hotel" | "product"; query: string } {
  const text = message.toLowerCase();
  if (/\b(flight|fly|airline|plane)\b/.test(text)) {
    const kl = /kuala lumpur|\bkl\b|\bkul\b/.test(text), sg = /singapore|\bsin\b|\bsg\b/.test(text);
    return { category: "flight", query: kl && sg ? (text.indexOf("singapore") < text.search(/kuala lumpur|\bkl\b|\bkul\b/) ? "SIN-KUL" : "KUL-SIN") : sg ? "SIN" : "" };
  }
  if (/\b(hotel|stay|room|accommodation)\b/.test(text)) return { category: "hotel", query: /geylang/.test(text) ? "GEYLANG" : /marina/.test(text) ? "MARINA" : "SINGAPORE" };
  if (/pokemon|pokémon/.test(text)) return { category: "product", query: "POKEMON" };
  if (/necklace|gift|birthday|girlfriend|present/.test(text)) return { category: "product", query: "NECKLACE" };
  const token = KNOWN_TOKENS.find(t => new RegExp(`\\b${t}\\b`).test(message.toUpperCase()));
  return { category: "signal", query: token ?? "MIN" };
}

async function scriptedRepay(agent: UserAgent, say: (t: string) => void, emit: (e: AgentEvent) => void) {
  const loan = await agent.myLoan();
  if (failed(loan)) return `Could not read your loan: ${loan.error}`;
  if (!loan.open_loan) return "You have no open loan to repay.";
  const repaid = await agent.repayLoan({ loan_id: loan.open_loan.loan_id });
  if (failed(repaid)) return `Repayment failed: ${repaid.error}`;
  if (repaid.status === "insufficient_funds") {
    await agent.notifyUser({ message: `Loan ${repaid.loan_id} needs ${repaid.due_usdm} USDM and the agent holds ${repaid.balance_usdm}. Top up ${repaid.shortfall_usdm} USDM to ${repaid.agent_wallet} before ${clock(loan.open_loan.deadline)}.` });
    return `Not repaid yet: ${repaid.shortfall_usdm} USDM is missing.`;
  }
  if (repaid.status !== "repaid") return `Repayment did not complete (${repaid.status}).`;
  say(`Repaid ${repaid.paid_usdm} USDM.`);
  showUi(emit, [ui.receipt({ title: "Loan repaid", amount: `${repaid.paid_usdm} USDM`, tx: repaid.payment_tx ? { hash: repaid.payment_tx } : undefined }), ui.text({ text: "Your pledged messages are unlocked.", tone: "good" })]);
  return `Repaid loan ${repaid.loan_id} in full (tx ${short(repaid.payment_tx)}); your chats are unlocked.`;
}

async function scriptedBrain(message: string, agent: UserAgent, emit: (e: AgentEvent) => void) {
  const say = (text: string) => emit({ type: "assistant", text });
  const status = await agent.status();
  if (failed(status)) return `CARSEM is not reachable: ${status.error}`;
  if (!status.onboarded) return (status as { next: string }).next;
  if (/\b(repay|pay back|pay off)\b/i.test(message)) return scriptedRepay(agent, say, emit);

  const { category, query } = intentOf(message);
  say(`Searching CARSEM for ${category === "signal" ? `a ${query} trading signal` : `${category} prices${query ? ` (${query})` : ""}`}.`);
  const found = await agent.searchData({ category, query });
  if (failed(found) || !found.results.length) return `Nothing on CARSEM for that yet${failed(found) ? `: ${found.error}` : "."}`;
  const best = found.results[0];
  showUi(emit, [
    ui.text({ text: `${found.results.length} result(s) on CARSEM, newest first:`, tone: "muted" }),
    ...found.results.slice(0, 3).map((r: { title: string; price_usdm: string; free?: boolean; uploader: string; uploader_reputation: number }) =>
      ui.dataCard({ title: r.title, meta: `${r.free ? "Free" : `${r.price_usdm} USDM over x402`} · ${r.uploader} ${Math.round(r.uploader_reputation * 100)}%`, rows: [], locked: !r.free })),
  ]);

  let bought = await agent.buyData({ listing_id: best.listing_id });
  if (failed(bought)) return `Purchase failed: ${bought.error}`;
  let loanId: string | undefined;
  if (bought.status === "insufficient_funds") {
    say(`"${best.title}" costs ${bought.price_usdm} USDM, but your agent only holds ${bought.balance_usdm}. I can borrow ${bought.price_usdm} USDM from CARSEM if you pledge some of your past messages as collateral.`);
    showUi(emit, [ui.paywall({ title: best.title, price: bought.price_usdm, balance: bought.balance_usdm, shortfall: bought.shortfall_usdm })]);
    const request = await agent.borrow({ amount_usdm: bought.price_usdm, purpose: best.title });
    if (failed(request)) return `I could not start borrowing: ${request.error}`;
    let loan;
    if (request.status === "selection_required") {
      if (request.your_messages.length < request.minimum_to_pledge) {
        await agent.notifyUser({ message: `To borrow you need at least ${request.minimum_to_pledge} past messages to choose from, and you have ${request.your_messages.length}. Add some (import your ChatGPT or Claude history, or the sample chats) and ask again.` });
        return "Stopped: not enough past messages to pledge yet.";
      }
      say(`Choose which of your past messages to pledge (at least ${request.minimum_to_pledge}). I'll wait.`);
      loan = await agent.borrowStatus({ request_id: request.request_id, wait_seconds: 600 });
    } else {
      loan = request;
    }
    if (failed(loan) || loan.status !== "borrowed") {
      const why = failed(loan) ? loan.error : loan.status === "declined" ? "you declined" : loan.status === "pending" ? "no messages were chosen in time" : `the request is ${loan.status}`;
      return `Stopped: no loan (${why}). Nothing was bought.`;
    }
    loanId = loan.loan_id;
    say(`Borrowed ${loan.amount_usdm} USDM (fee ${loan.fee_usdm}, due ${loan.total_due_usdm} by ${clock(loan.deadline)}); ${loan.collateral}. Buying now.`);
    showUi(emit, [ui.loan({ loanId: loan.loan_id, amount: loan.amount_usdm, fee: loan.fee_usdm, due: loan.total_due_usdm, deadline: loan.deadline ?? "", collateral: loan.collateral, status: "open" })]);
    bought = await agent.buyData({ listing_id: best.listing_id });
    if (failed(bought)) return `Purchase failed after borrowing: ${bought.error}`;
  }
  if (bought.status !== "delivered") return `The data was not delivered (${bought.status}).`;
  const data = bought.listing as { title: string; data: Record<string, unknown> };
  say(`Got it: ${data.title}. Proof of delivery ${short(bought.delivery_hash)} is logged on chain.`);
  let summary = `Bought "${data.title}" (tx ${short(bought.payment_tx)}).`;
  const cards: UiCode[] = [ui.dataCard({ title: data.title, meta: `${bought.paid_usdm} USDM over x402 · proof ${short(bought.delivery_hash)} on chain`, rows: dataRows(category, data.data), locked: false, tx: { hash: bought.payment_tx, url: bought.payment_explorer } })];

  if (category === "signal") {
    const trade = await agent.tradeSignal({ delivery_id: bought.delivery_id });
    if (!failed(trade)) {
      summary += ` Trade ${trade.outcome}: ${trade.pnlUsdm >= 0 ? "+" : ""}${trade.pnlUsdm} USDM (simulated Minswap fill).`;
      cards.push(ui.trade({ pair: String(data.data.pair ?? data.title), side: String(trade.side ?? data.data.direction ?? ""), outcome: trade.outcome, pnl: `${trade.pnlUsdm >= 0 ? "+" : ""}${trade.pnlUsdm}`, venue: String(trade.venue ?? "Minswap (simulated)"), tx: trade.payout?.tx ? { hash: trade.payout.tx.txHash, url: trade.payout.tx.explorerUrl } : undefined }));
    }
  }
  if (!loanId) { showUi(emit, cards); return summary; }

  const [loan, after] = [await agent.myLoan(), await agent.status()];
  if (failed(loan) || failed(after) || !loan.open_loan || !after.onboarded) return `${summary} Loan ${loanId} status unknown.`;
  const wallet = (after as { wallet: { USDM: string; address: string } }).wallet;
  if (toUnits(wallet.USDM) >= toUnits(loan.open_loan.outstanding_usdm)) {
    const repaid = await agent.repayLoan({ loan_id: loanId });
    if (!failed(repaid) && repaid.status === "repaid") {
      showUi(emit, [...cards, ui.receipt({ title: "Loan repaid", amount: `${loan.open_loan.total_due_usdm} USDM`, tx: repaid.payment_tx ? { hash: repaid.payment_tx } : undefined }), ui.text({ text: "Collateral released: your pledged messages are unlocked.", tone: "good" })]);
      return `${summary} Repaid the ${loan.open_loan.total_due_usdm} USDM loan (tx ${short(repaid.payment_tx)}); your chats are unlocked.`;
    }
  }
  const missing = (Number(loan.open_loan.outstanding_usdm) - Number(wallet.USDM)).toFixed(2);
  await agent.notifyUser({
    message: `Loan ${loanId}: ${loan.open_loan.outstanding_usdm} USDM is due by ${clock(loan.open_loan.deadline)} and I hold ${wallet.USDM}. Top up ${missing} USDM to ${wallet.address} and say "repay my loan", or your redacted chats will be published on CARSEM for any user to buy.`,
  });
  showUi(emit, [...cards,
    ui.loan({ loanId, amount: String(loan.open_loan.total_due_usdm), fee: "included", due: String(loan.open_loan.outstanding_usdm), deadline: loan.open_loan.deadline ?? "", collateral: `Top up ${missing} USDM to ${wallet.address}, or your pledged messages are published on CARSEM.`, status: "open" }),
    ui.actions([ui.button("Repay my loan", toAgent("Repay my loan"), "primary")]),
  ]);
  return `${summary} Loan ${loanId} is still open; I asked you to top up ${missing} USDM.`;
}

export async function runAgent(message: string, options: { agent: UserAgent; config: GatewayConfig; emit: (event: AgentEvent) => void; brain?: Brain }) {
  const { agent, config, emit } = options;
  const brain: Brain = options.brain ?? (config.openai.apiKey ? "openai" : "scripted");
  emit({ type: "run_started", message, brain });
  try {
    const summary = brain === "openai" ? await openaiBrain(message, agent, config, emit) : await scriptedBrain(message, agent, emit);
    emit({ type: "run_finished", summary });
    return { brain, summary, notifications: agent.notifications };
  } catch (error) {
    emit({ type: "error", message: (error as Error).message });
    throw error;
  }
}

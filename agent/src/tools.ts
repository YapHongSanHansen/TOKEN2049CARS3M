/**
 * What the agent can do. Each tool returns plain JSON for the model and emits
 * activity events so the UI can show the agent "thinking" step by step.
 */
import { LOVELACE, fromUnits, toUnits } from "@carsem/shared";
import { api, ApiError } from "./api.js";
import type { AgentConfig } from "./config.js";
import type { AgentWallet } from "./wallet.js";
import { paidFetch, type X402Step } from "./x402Client.js";

export type AgentEvent =
  | { type: "run_started"; message: string; brain: string }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "x402"; tool: string; step: X402Step["step"]; detail: Record<string, unknown> }
  | { type: "notify_user"; message: string }
  | { type: "run_finished"; summary: string }
  | { type: "error"; message: string };

export interface ServiceInfo { mode: string; usdmAsset: string; treasury: string; signalPrice: string }

export class AgentTools {
  private info?: ServiceInfo;
  readonly notifications: string[] = [];

  constructor(
    readonly config: AgentConfig,
    readonly wallet: AgentWallet,
    private readonly emit: (event: AgentEvent) => void,
    /** Demo control: force the simulated DEX outcome for this run. */
    private readonly forceOutcome?: "win" | "loss",
  ) {}

  async service(): Promise<ServiceInfo> {
    this.info ??= await api<ServiceInfo>(this.config.apiUrl, "/health");
    if (this.info.mode !== this.config.mode) throw new Error(`carsem-api runs CHAIN_MODE=${this.info.mode} but the agent has ${this.config.mode}`);
    return this.info;
  }

  /** Runs a tool with call/result events; failures become `{ error }` results the model can act on. */
  async call<T>(tool: string, input: unknown, run: () => Promise<T>): Promise<T | { error: string; status?: number }> {
    this.emit({ type: "tool_call", tool, input });
    let result: T | { error: string; status?: number };
    try { result = await run(); }
    catch (error) { result = { error: (error as Error).message, ...(error instanceof ApiError ? { status: error.status } : {}) }; }
    this.emit({ type: "tool_result", tool, result });
    return result;
  }

  private async balancesView() {
    const { usdmAsset } = await this.service();
    const balances = await this.wallet.balances();
    return { usdm: balances[usdmAsset] ?? 0n, lovelace: balances[LOVELACE] ?? 0n };
  }

  checkBalance() {
    return this.call("check_balance", {}, async () => {
      const { usdm, lovelace } = await this.balancesView();
      return { address: this.wallet.address, tUSDM: fromUnits(usdm), tADA: fromUnits(lovelace), mode: this.config.mode };
    });
  }

  getSignal(input: { token: string }) {
    return this.call("get_signal", input, async () => {
      const { usdmAsset } = await this.service();
      const token = input.token.trim().toUpperCase();
      let shortfall: { price: bigint; balance: bigint } | undefined;
      const result = await paidFetch<any>(`${this.config.apiUrl}/signals/latest?token=${encodeURIComponent(token)}`, {
        wallet: this.wallet, asset: usdmAsset, maxAmount: this.config.maxPayment,
        beforePay: async offer => {
          const { usdm, lovelace } = await this.balancesView();
          const price = BigInt(offer.amount);
          if (usdm < price) { shortfall = { price, balance: usdm }; return "insufficient_funds"; }
          if (lovelace < 2_000_000n) return "insufficient tADA for the network fee";
        },
        onStep: step => this.emit({ type: "x402", tool: "get_signal", ...step }),
      });
      if (shortfall) {
        return {
          status: "insufficient_funds" as const,
          message: `The signal costs ${fromUnits(shortfall.price)} tUSDM via x402 but the wallet holds ${fromUnits(shortfall.balance)} tUSDM.`,
          price_usdm: fromUnits(shortfall.price),
          balance_usdm: fromUnits(shortfall.balance),
          shortfall_usdm: fromUnits(shortfall.price - shortfall.balance),
        };
      }
      if (result.declined) return { status: "not_paid" as const, reason: result.declined, price_usdm: result.offer && fromUnits(result.offer.amount) };
      if (result.status !== 200) return { status: "failed" as const, http: result.status, error: result.body?.error ?? result.receipt?.errorReason };
      const { signal, delivery, payment } = result.body;
      return {
        status: "delivered" as const,
        signal,
        delivery_id: delivery.id,
        delivery_hash: delivery.hash,
        payment_tx: payment.tx,
        payment_explorer: payment.explorerUrl,
        paid_usdm: payment.price,
      };
    });
  }

  borrow(input: { amount_usdm: string }) {
    return this.call("borrow", input, async () => {
      const loan = await api(this.config.apiUrl, "/loans", {
        body: { agentId: this.config.agentId, amount: String(input.amount_usdm) },
        headers: { Authorization: `Bearer ${this.config.agentKey}` },
      });
      return {
        loan_id: loan.id, status: loan.status, amount_usdm: loan.amount, fee_usdm: loan.fee, total_due_usdm: loan.totalDue,
        deadline: loan.deadline, seconds_left: loan.secondsLeft, collateral_ref: loan.collateralRef,
        disburse_tx: loan.disburseTx?.hash, disburse_explorer: loan.disburseTx?.explorerUrl,
      };
    });
  }

  executeTrade(input: { delivery_id: string; size_ada?: number }) {
    return this.call("execute_trade", input, async () => {
      const trade = await api(this.config.apiUrl, "/dex/swap", {
        body: { agentAddress: this.wallet.address, deliveryId: input.delivery_id, sizeAda: input.size_ada ?? this.config.tradeSizeAda, forceOutcome: this.forceOutcome },
      });
      return { ...trade, note: "Simulated fill on a Minswap stand-in; profit is paid on chain in tUSDM." };
    });
  }

  myLoans() {
    return this.call("my_loans", {}, async () => {
      const loans = await api<any[]>(this.config.apiUrl, `/loans?agentId=${encodeURIComponent(this.config.agentId)}`);
      return loans.slice(0, 5).map(l => ({ loan_id: l.id, status: l.status, outstanding_usdm: l.outstanding, total_due_usdm: l.totalDue, deadline: l.deadline, seconds_left: l.secondsLeft }));
    });
  }

  loanStatus(input: { loan_id: string }) {
    return this.call("loan_status", input, async () => {
      const loan = await api(this.config.apiUrl, `/loans/${encodeURIComponent(input.loan_id)}`);
      return { loan_id: loan.id, status: loan.status, outstanding_usdm: loan.outstanding, total_due_usdm: loan.totalDue, seconds_left: loan.secondsLeft, deadline: loan.deadline };
    });
  }

  repay(input: { loan_id: string }) {
    return this.call("repay", input, async () => {
      const { usdmAsset } = await this.service();
      let shortfall: { due: bigint; balance: bigint } | undefined;
      const result = await paidFetch<any>(`${this.config.apiUrl}/loans/${encodeURIComponent(input.loan_id)}/repay`, {
        method: "POST", wallet: this.wallet, asset: usdmAsset, maxAmount: this.config.maxPayment,
        beforePay: async offer => {
          const { usdm } = await this.balancesView();
          if (usdm < BigInt(offer.amount)) { shortfall = { due: BigInt(offer.amount), balance: usdm }; return "insufficient_funds"; }
        },
        onStep: step => this.emit({ type: "x402", tool: "repay", ...step }),
      });
      if (shortfall) return { status: "insufficient_funds" as const, due_usdm: fromUnits(shortfall.due), balance_usdm: fromUnits(shortfall.balance), shortfall_usdm: fromUnits(shortfall.due - shortfall.balance) };
      if (result.status !== 200) return { status: "failed" as const, http: result.status, error: result.body?.error ?? result.receipt?.errorReason };
      const loan = await api(this.config.apiUrl, `/loans/${encodeURIComponent(input.loan_id)}`);
      return { status: loan.status, paid_usdm: result.body.paid, payment_tx: result.receipt?.transaction, collateral: loan.status === "repaid" ? "released" : "still pledged", loan_outstanding_usdm: loan.outstanding };
    });
  }

  notifyUser(input: { message: string }) {
    return this.call("notify_user", input, async () => {
      this.notifications.push(input.message);
      this.emit({ type: "notify_user", message: input.message });
      return { delivered: true };
    });
  }
}

/** Parses "5", "5.0", 5 into a tUSDM amount string; throws on junk. */
export const usdmAmount = (value: unknown) => fromUnits(toUnits(String(value)));

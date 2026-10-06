/**
 * The user's agent: what any AI app (Hermes, Claude Code, ChatGPT, Claude, curl)
 * can do on CARSEM through the gateway. Each instance acts for one user, with
 * their CARSEM key and their one hosted wallet. Every call is logged as
 * activity, so the dashboard shows the agent working live.
 */
import { LOVELACE, fromUnits, toUnits } from "@carsem/shared";
import { api, ApiError } from "./api.js";
import type { GatewayConfig } from "./config.js";
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

export interface ServiceInfo { mode: string; usdmAsset: string; treasury: string; publicAccessPrice: string; issuer: string }
type Failure = { error: string; status?: number; code?: string };

export class UserAgent {
  private info?: ServiceInfo;
  readonly notifications: string[] = [];

  constructor(
    readonly config: GatewayConfig,
    private readonly key: string,
    /** Undefined until onboarding is complete. */
    readonly wallet: AgentWallet | undefined,
    private readonly emit: (event: AgentEvent) => void,
    /** Demo control: force the simulated DEX outcome. */
    private readonly forceOutcome?: "win" | "loss",
  ) {}

  private carsem<T = any>(path: string, init: { method?: string; body?: unknown } = {}) {
    return api<T>(this.config.apiUrl, path, { ...init, headers: { Authorization: `Bearer ${this.key}` } });
  }

  private async service(): Promise<ServiceInfo> {
    this.info ??= await api<ServiceInfo>(this.config.apiUrl, "/health");
    return this.info;
  }

  private requireWallet(): AgentWallet {
    if (!this.wallet) throw new ApiError(403, "Finish onboarding first (Masumi DID + KYC + consent). Call carsem_status for the link.");
    return this.wallet;
  }

  private async balances() {
    const { usdmAsset } = await this.service();
    const balances = await this.requireWallet().balances();
    return { usdm: balances[usdmAsset] ?? 0n, lovelace: balances[LOVELACE] ?? 0n };
  }

  /** Runs a tool with call/result events; failures become `{ error }` results the model can act on. */
  private async call<T>(tool: string, input: unknown, run: () => Promise<T>): Promise<T | Failure> {
    this.emit({ type: "tool_call", tool, input });
    let result: T | Failure;
    try { result = await run(); }
    catch (error) {
      result = error instanceof ApiError
        ? { error: error.message.replace(/^[A-Z]+ \S+: /, ""), status: error.status, ...((error.body as { code?: string })?.code ? { code: (error.body as { code: string }).code } : {}) }
        : { error: (error as Error).message };
    }
    this.emit({ type: "tool_result", tool, result });
    return result;
  }

  status() {
    return this.call("carsem_status", {}, async () => {
      const profile = await this.carsem("/me");
      if (!profile.onboarded) {
        return { onboarded: false, next: `Open ${profile.connect.onboarding} to verify with your Masumi DID (KYC + consent). CARSEM tools work after that.`, steps: profile.steps };
      }
      const [{ usdm, lovelace }, loans, synced] = await Promise.all([this.balances(), this.carsem<any[]>("/me/loans"), this.carsem("/me/sync")]);
      const open = loans.find(l => l.status === "open");
      return {
        onboarded: true,
        identity: { did: profile.identity?.did, kyc: profile.kyc.status, agentDid: profile.agent?.did, masumi: profile.agent?.masumi },
        wallet: { address: this.wallet!.address, USDM: fromUnits(usdm), tADA: fromUnits(lovelace) },
        syncedContext: { items: synced.items, readyToBorrow: synced.readyToBorrow, lastSyncedAt: synced.lastSyncedAt },
        openLoan: open ? { loan_id: open.id, outstanding_usdm: open.outstanding, deadline: open.deadline, seconds_left: open.secondsLeft } : null,
        earnings_usdm: profile.earnings,
      };
    });
  }

  searchData(input: { category: string; query?: string }) {
    return this.call("search_data", input, async () => {
      const results = await this.carsem<any[]>(`/data/search?category=${encodeURIComponent(input.category)}&q=${encodeURIComponent(input.query ?? "")}`);
      return { results: results.map(r => ({ listing_id: r.id, title: r.title, price_usdm: r.price, uploader: r.uploader.name, uploader_reputation: r.uploader.reputation, published_at: r.publishedAt, validated: r.validated })) };
    });
  }

  buyData(input: { listing_id?: string; category?: string; query?: string }) {
    return this.call("buy_data", input, async () => {
      const wallet = this.requireWallet();
      let listingId = input.listing_id;
      if (!listingId) {
        if (!input.category) throw new Error("Give a listing_id, or a category and query");
        const [best] = await this.carsem<any[]>(`/data/search?category=${encodeURIComponent(input.category)}&q=${encodeURIComponent(input.query ?? "")}`);
        if (!best) return { status: "not_found" as const, message: `No ${input.category} data for "${input.query ?? ""}"` };
        listingId = best.id as string;
      }
      const { usdmAsset } = await this.service();
      let shortfall: { price: bigint; balance: bigint } | undefined;
      const result = await paidFetch<any>(`${this.config.apiUrl}/data/listings/${encodeURIComponent(listingId)}`, {
        wallet, asset: usdmAsset, maxAmount: this.config.maxPayment, headers: { Authorization: `Bearer ${this.key}` },
        beforePay: async offer => {
          const { usdm, lovelace } = await this.balances();
          const price = BigInt(offer.amount);
          if (usdm < price) { shortfall = { price, balance: usdm }; return "insufficient_funds"; }
          if (lovelace < 2_000_000n) return "insufficient tADA for the network fee";
        },
        onStep: step => this.emit({ type: "x402", tool: "buy_data", ...step }),
      });
      if (shortfall) {
        return {
          status: "insufficient_funds" as const, listing_id: listingId,
          message: `This costs ${fromUnits(shortfall.price)} USDM via x402 but the agent wallet holds ${fromUnits(shortfall.balance)} USDM. Borrow from CARSEM (collateral borrowing) to continue.`,
          price_usdm: fromUnits(shortfall.price), balance_usdm: fromUnits(shortfall.balance), shortfall_usdm: fromUnits(shortfall.price - shortfall.balance),
        };
      }
      if (result.declined) return { status: "not_paid" as const, reason: result.declined };
      if (result.status !== 200) return { status: "failed" as const, http: result.status, error: result.body?.error ?? result.receipt?.errorReason };
      const { listing, delivery, payment } = result.body;
      return {
        status: "delivered" as const, listing, delivery_id: delivery.id, delivery_hash: delivery.hash,
        proof: "hash(request + data) is logged on chain as proof of delivery", payment_tx: payment.tx, payment_explorer: payment.explorerUrl, paid_usdm: payment.price,
      };
    });
  }

  syncContext(input: { items: string[]; source?: string }) {
    return this.call("sync_context", { items: `${input.items.length} item(s)`, source: input.source ?? "assistant" }, async () => {
      const result = await this.carsem("/me/sync", { body: { source: input.source ?? "assistant", items: input.items } });
      return { added: result.added, duplicates: result.duplicates, withheld: result.withheld, total_items: result.items, ready_to_borrow: result.readyToBorrow, note: "Redacted by CARSEM on arrival; raw text is never stored." };
    });
  }

  borrow(input: { amount_usdm: string }) {
    return this.call("borrow", input, async () => {
      try {
        const loan = await this.carsem("/loans", { body: { amount: String(input.amount_usdm) } });
        return {
          status: "borrowed" as const, loan_id: loan.id, amount_usdm: loan.amount, fee_usdm: loan.fee, total_due_usdm: loan.totalDue, deadline: loan.deadline, seconds_left: loan.secondsLeft,
          collateral: `${loan.collateral.items} redacted items locked (collateral_ref ${String(loan.collateral.ref).slice(0, 16)}…)`,
          disburse_tx: loan.disburseTx?.hash, disburse_explorer: loan.disburseTx?.explorerUrl,
        };
      } catch (error) {
        if (error instanceof ApiError && (error.body as { code?: string })?.code === "sync_required") {
          return { status: "sync_required" as const, message: (error.body as { error: string }).error, next: "Call sync_context with what you know about the user (short factual lines from this conversation and your memory), then borrow again." };
        }
        throw error;
      }
    });
  }

  tradeSignal(input: { delivery_id: string; size_ada?: number }) {
    return this.call("trade_signal", input, async () => {
      this.requireWallet();
      const trade = await this.carsem("/dex/swap", { body: { deliveryId: input.delivery_id, sizeAda: input.size_ada ?? this.config.tradeSizeAda, forceOutcome: this.forceOutcome } });
      return { ...trade, note: "Simulated fill on a Minswap stand-in; profit is paid on chain in USDM." };
    });
  }

  myLoan() {
    return this.call("my_loan", {}, async () => {
      const loans = await this.carsem<any[]>("/me/loans");
      const view = (l: any) => ({ loan_id: l.id, status: l.status, outstanding_usdm: l.outstanding, total_due_usdm: l.totalDue, deadline: l.deadline, seconds_left: l.secondsLeft, collateral: l.collateral });
      const open = loans.find(l => l.status === "open");
      return { open_loan: open ? view(open) : null, recent: loans.slice(0, 3).map(view) };
    });
  }

  repayLoan(input: { loan_id?: string }) {
    return this.call("repay_loan", input, async () => {
      const wallet = this.requireWallet();
      const loanId = input.loan_id ?? (await this.carsem<any[]>("/me/loans")).find(l => l.status === "open")?.id;
      if (!loanId) return { status: "no_open_loan" as const };
      const { usdmAsset } = await this.service();
      let shortfall: { due: bigint; balance: bigint } | undefined;
      const result = await paidFetch<any>(`${this.config.apiUrl}/loans/${encodeURIComponent(loanId)}/repay`, {
        method: "POST", wallet, asset: usdmAsset, maxAmount: this.config.maxPayment,
        beforePay: async offer => {
          const { usdm } = await this.balances();
          if (usdm < BigInt(offer.amount)) { shortfall = { due: BigInt(offer.amount), balance: usdm }; return "insufficient_funds"; }
        },
        onStep: step => this.emit({ type: "x402", tool: "repay_loan", ...step }),
      });
      if (shortfall) return { status: "insufficient_funds" as const, loan_id: loanId, due_usdm: fromUnits(shortfall.due), balance_usdm: fromUnits(shortfall.balance), shortfall_usdm: fromUnits(shortfall.due - shortfall.balance), agent_wallet: wallet.address };
      if (result.status !== 200) return { status: "failed" as const, http: result.status, error: result.body?.error ?? result.receipt?.errorReason };
      const loan = await this.carsem(`/loans/${encodeURIComponent(loanId)}`);
      return { status: loan.status, loan_id: loanId, paid_usdm: result.body.paid, payment_tx: result.receipt?.transaction, collateral: loan.status === "repaid" ? "released" : "still locked", outstanding_usdm: loan.outstanding };
    });
  }

  uploadData(input: { category: string; title?: string; data: Record<string, unknown>; price_usdm?: string }) {
    return this.call("upload_data", input, async () => {
      const listing = await this.carsem("/data/listings", { body: { category: input.category, title: input.title, data: input.data, price: input.price_usdm } });
      return { ...listing, note: "Uploads are not validated; your uploader reputation grows when buyers find the data useful." };
    });
  }

  rateData(input: { delivery_id: string; useful: boolean }) {
    return this.call("rate_data", input, () => this.carsem(`/data/deliveries/${encodeURIComponent(input.delivery_id)}/rate`, { body: { useful: input.useful } }));
  }

  browsePublished() {
    return this.call("browse_published_data", {}, async () => {
      const bundles = await this.carsem<any[]>("/market/bundles");
      return { published: bundles.filter(b => b.status === "published").map(b => ({ bundle_id: b.id, preview: b.preview, stats: b.stats, price_usdm: b.publicAccess?.price, you_own_it: b.publicAccess?.youOwnIt, is_yours: b.publicAccess?.isYours })) };
    });
  }

  accessPublished(input: { bundle_id: string }) {
    return this.call("access_published_data", input, async () => {
      const wallet = this.requireWallet();
      const { usdmAsset } = await this.service();
      const result = await paidFetch<any>(`${this.config.apiUrl}/market/bundles/${encodeURIComponent(input.bundle_id)}/access`, {
        method: "POST", wallet, asset: usdmAsset, maxAmount: this.config.maxPayment, headers: { Authorization: `Bearer ${this.key}` },
        onStep: step => this.emit({ type: "x402", tool: "access_published_data", ...step }),
      });
      if (result.status !== 200) return { status: "failed" as const, http: result.status, error: result.body?.error ?? result.receipt?.errorReason };
      return { status: "accessed" as const, bundle: result.body.bundle, payment_tx: result.body.payment.tx };
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

/** "5", 5 → "5"; throws on junk. */
export const usdmAmount = (value: unknown) => fromUnits(toUnits(String(value)));

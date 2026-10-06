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
  /** OpenUI Lang the web chat renders (see @carsem/shared/genui). */
  | { type: "ui"; code: string }
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
      const [{ usdm, lovelace }, loans, history] = await Promise.all([this.balances(), this.carsem<any[]>("/me/loans"), this.carsem("/me/messages")]);
      const open = loans.find(l => l.status === "open");
      return {
        onboarded: true,
        identity: { did: profile.identity?.did, kyc: profile.kyc.status, agentDid: profile.agent?.did, masumi: profile.agent?.masumi },
        wallet: { address: this.wallet!.address, USDM: fromUnits(usdm), tADA: fromUnits(lovelace) },
        pastMessages: { count: history.messages.length, canBorrow: history.canBorrow, minimumToPledge: history.minimumToPledge },
        openLoan: open ? { loan_id: open.id, outstanding_usdm: open.outstanding, deadline: open.deadline, seconds_left: open.secondsLeft } : null,
        earnings_usdm: profile.earnings,
      };
    });
  }

  searchData(input: { category: string; query?: string }) {
    return this.call("search_data", input, async () => {
      const results = await this.carsem<any[]>(`/data/search?category=${encodeURIComponent(input.category)}&q=${encodeURIComponent(input.query ?? "")}`);
      return { results: results.map(r => ({ listing_id: r.id, title: r.title, price_usdm: r.price, free: r.free, uploader: r.uploader.name, uploader_reputation: r.uploader.reputation, published_at: r.publishedAt, validated: r.validated })) };
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
      if (result.body.free) {
        return { status: "free" as const, listing: result.body.listing, message: "Free data (older, from about 5 days ago): no payment needed. Fresh data is paid; buy it to trade a signal." };
      }
      const { listing, delivery, payment } = result.body;
      return {
        status: "delivered" as const, listing, delivery_id: delivery.id, delivery_hash: delivery.hash,
        proof: "hash(request + data) is logged on chain as proof of delivery", payment_tx: payment.tx, payment_explorer: payment.explorerUrl, paid_usdm: payment.price,
      };
    });
  }

  /** Adds past messages to the user's history (redacted by CARSEM on arrival). */
  addMessages(input: { messages: string[]; source?: string }) {
    return this.call("add_messages", { messages: `${input.messages.length} message(s)`, source: input.source ?? "assistant" }, async () => {
      const result = await this.carsem("/me/sync", { body: { source: input.source ?? "assistant", items: input.messages } });
      return { added: result.added, duplicates: result.duplicates, withheld: result.withheld, total_messages: result.messages, note: "Redacted by CARSEM on arrival; raw text is never stored." };
    });
  }

  private async candidates() {
    const { messages, minimumToPledge } = await this.carsem<{ messages: Array<{ id: number; text: string; intents: string[]; source: string; state: string | null }>; minimumToPledge: number }>("/me/messages");
    return { minimum: minimumToPledge, messages: messages.filter(m => !m.state).slice(0, 25).map(m => ({ id: m.id, text: m.text, intents: m.intents, source: m.source })) };
  }

  listMyMessages() {
    return this.call("list_my_messages", {}, async () => {
      const { minimum, messages } = await this.candidates();
      return { minimum_to_pledge: minimum, messages };
    });
  }

  private loanView(loan: any) {
    return {
      status: "borrowed" as const, loan_id: loan.id, amount_usdm: loan.amount, fee_usdm: loan.fee, total_due_usdm: loan.totalDue, deadline: loan.deadline, seconds_left: loan.secondsLeft,
      collateral: `${loan.collateral.items} of your past messages pledged (collateral_ref ${String(loan.collateral.ref).slice(0, 16)}…)`,
      disburse_tx: loan.disburseTx?.hash, disburse_explorer: loan.disburseTx?.explorerUrl,
    };
  }

  /**
   * Collateral borrowing. Without message_ids it opens a request and returns the user's past
   * messages to choose from; with message_ids (chosen by the user) it takes the loan.
   */
  borrow(input: { amount_usdm: string; purpose?: string; message_ids?: number[]; request_id?: string }) {
    return this.call("borrow", input, async () => {
      if (input.message_ids?.length) {
        const loan = await this.carsem("/loans", { body: { amount: String(input.amount_usdm), messageIds: input.message_ids, requestId: input.request_id } });
        return this.loanView(loan);
      }
      const request = await this.carsem("/loan-requests", { body: { amount: String(input.amount_usdm), purpose: input.purpose ?? "" } });
      const { minimum, messages } = await this.candidates();
      const profile = await this.carsem("/me");
      return {
        status: "selection_required" as const,
        request_id: request.id,
        amount_usdm: request.amount,
        minimum_to_pledge: minimum,
        your_messages: messages,
        approve_in_app: String(profile.connect.onboarding).replace("#start", "#agent"),
        next: messages.length >= minimum
          ? `Ask the user which of these past messages to pledge as collateral (at least ${minimum}), then call borrow again with message_ids and request_id. If you cannot ask them directly, call borrow_status with wait_seconds so they can choose in the CARSEM app.`
          : `The user has only ${messages.length} past message(s); at least ${minimum} are needed. Add what you know about them with add_messages (or they can import their chat history), then borrow again.`,
      };
    });
  }

  borrowStatus(input: { request_id: string; wait_seconds?: number }) {
    return this.call("borrow_status", input, async () => {
      const deadline = Date.now() + Math.min(Math.max(input.wait_seconds ?? 0, 0), 900) * 1000;
      for (;;) {
        const request = await this.carsem(`/loan-requests/${encodeURIComponent(input.request_id)}`);
        if (request.status === "approved" && request.loan) return this.loanView(request.loan);
        if (request.status !== "pending") return { status: request.status as "declined" | "expired", request_id: request.id };
        if (Date.now() >= deadline) return { status: "pending" as const, request_id: request.id, message: "The user has not chosen yet." };
        await new Promise(resolve => setTimeout(resolve, 1500));
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

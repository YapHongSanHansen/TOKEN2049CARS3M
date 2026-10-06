/**
 * CARSEM Lending — our contribution (Masumi has no lending primitive).
 *
 *   borrow   gate (Masumi DID + KYC credential + consent) → sync snapshot sealed as collateral
 *            → treasury pays the agent on chain (metadata carries loan id + collateral_ref)
 *   repay    an x402 payment of the outstanding amount → collateral released
 *   default  deadline passes with money owed → the redacted bundle is published on CARSEM
 *            for every user to access for a fee, and it keeps selling
 */
import { fromUnits } from "@carsem/shared";
import type { Chain } from "../chain/index.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { Sync } from "./sync.js";
import type { UserRow, Users } from "./users.js";

export interface LoanRow {
  id: string; agent_id: string; user_id: string; amount_units: string; fee_units: string; repaid_units: string;
  deadline: number | null; status: "disbursing" | "open" | "repaid" | "defaulted"; collateral_ref: string; bundle_id: string;
  disburse_tx: string | null; created_at: number; closed_at: number | null;
}

export class Lending {
  constructor(
    private readonly db: Db, private readonly config: Config, private readonly chain: Chain,
    private readonly users: Users, private readonly sync: Sync,
  ) {}

  fee(amount: bigint) { return (amount * this.config.loanFeeBps + 9_999n) / 10_000n; }

  terms() {
    return {
      asset: this.config.usdmAsset, maxAmount: fromUnits(this.config.loanMax), feeBps: Number(this.config.loanFeeBps),
      deadlineSeconds: this.config.loanDeadlineMs / 1000, minSyncedItems: this.config.minSyncItems,
      collateral: "rights to the user's redacted chats, snapshotted when the loan starts",
      onDefault: `the redacted chats are published on CARSEM; any user can access them for ${fromUnits(this.config.publicAccessPrice)} USDM, and they keep selling`,
    };
  }

  get(id: string): LoanRow {
    const loan = this.db.get<LoanRow>("SELECT * FROM loans WHERE id = ?", id);
    if (!loan) throw new HttpError(404, `No loan ${id}`);
    return loan;
  }

  outstanding(loan: LoanRow) {
    const due = BigInt(loan.amount_units) + BigInt(loan.fee_units) - BigInt(loan.repaid_units);
    return due > 0n ? due : 0n;
  }

  view(loan: LoanRow) {
    const events = this.db.all<{ kind: string; amount_units: string | null; tx: string | null; detail_json: string | null; created_at: number }>(
      "SELECT kind, amount_units, tx, detail_json, created_at FROM loan_events WHERE loan_id = ? ORDER BY id", loan.id);
    const bundle = this.db.get<{ version: number; item_count: number; status: string }>("SELECT version, item_count, status FROM bundles WHERE id = ?", loan.bundle_id);
    return {
      id: loan.id, agentId: loan.agent_id, userId: loan.user_id, status: loan.status,
      amount: fromUnits(loan.amount_units), fee: fromUnits(loan.fee_units), repaid: fromUnits(loan.repaid_units),
      outstanding: fromUnits(this.outstanding(loan)), totalDue: fromUnits(BigInt(loan.amount_units) + BigInt(loan.fee_units)), asset: this.config.usdmAsset,
      deadline: loan.deadline ? new Date(loan.deadline).toISOString() : null,
      secondsLeft: loan.deadline && loan.status === "open" ? Math.max(0, Math.round((loan.deadline - Date.now()) / 1000)) : null,
      collateral: { ref: loan.collateral_ref, bundleId: loan.bundle_id, version: bundle?.version, items: bundle?.item_count, status: bundle?.status },
      disburseTx: loan.disburse_tx && { hash: loan.disburse_tx, explorerUrl: this.chain.explorerTx(loan.disburse_tx) },
      repayUrl: loan.status === "open" ? `${this.config.publicUrl}/loans/${loan.id}/repay` : null,
      createdAt: new Date(loan.created_at).toISOString(), closedAt: loan.closed_at ? new Date(loan.closed_at).toISOString() : null,
      events: events.map(e => ({
        kind: e.kind, amount: e.amount_units && fromUnits(e.amount_units), at: new Date(e.created_at).toISOString(),
        tx: e.tx && { hash: e.tx, explorerUrl: this.chain.explorerTx(e.tx) }, ...(e.detail_json ? JSON.parse(e.detail_json) : {}),
      })),
    };
  }

  list(filter: { userId?: string; status?: string } = {}) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.userId) { clauses.push("user_id = ?"); params.push(filter.userId); }
    if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
    return this.db.all<LoanRow>(`SELECT * FROM loans ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 100`, ...params)
      .map(loan => this.view(loan));
  }

  private event(loanId: string, kind: string, amount?: bigint, tx?: string, detail?: Record<string, unknown>) {
    this.db.run("INSERT INTO loan_events (loan_id, kind, amount_units, tx, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      loanId, kind, amount?.toString() ?? null, tx ?? null, detail ? JSON.stringify(detail) : null, Date.now());
  }

  async borrow(user: UserRow, amount: bigint) {
    const agent = this.users.requireOnboarded(user);
    if (amount <= 0n) throw new HttpError(400, "amount must be positive");
    if (amount > this.config.loanMax) throw new HttpError(400, `amount exceeds the ${fromUnits(this.config.loanMax)} USDM limit`);
    const fee = this.fee(amount);
    const loanId = newId("loan");

    // One loan at a time; the collateral is everything synced up to this moment.
    const bundle = this.db.transaction(() => {
      if (this.db.get("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('disbursing','open')", user.id)) {
        throw new HttpError(409, "There is already an open loan against your data. Repay it first.");
      }
      const bundle = this.sync.snapshot(user.id);
      this.db.run("INSERT INTO loans (id, agent_id, user_id, amount_units, fee_units, status, collateral_ref, bundle_id, created_at) VALUES (?, ?, ?, ?, ?, 'disbursing', ?, ?, ?)",
        loanId, agent.id, user.id, amount.toString(), fee.toString(), bundle.collateral_ref, bundle.id, Date.now());
      return bundle;
    });

    let disbursed;
    try {
      disbursed = await this.chain.transfer("treasury", agent.address, this.config.usdmAsset, amount, { msg: ["CARSEM loan disbursement", loanId, bundle.collateral_ref] });
    } catch (error) {
      this.db.transaction(() => {
        this.db.run("DELETE FROM loans WHERE id = ?", loanId);
        this.db.run("DELETE FROM bundles WHERE id = ?", bundle.id);
      });
      throw new HttpError(502, `Disbursement failed: ${(error as Error).message}`);
    }
    // The deadline starts when the money is on chain.
    const deadline = Date.now() + this.config.loanDeadlineMs;
    this.db.transaction(() => {
      this.db.run("UPDATE loans SET status = 'open', deadline = ?, disburse_tx = ? WHERE id = ?", deadline, disbursed.txHash, loanId);
      this.event(loanId, "collateral_locked", undefined, undefined, { bundleId: bundle.id, items: bundle.item_count, collateralRef: bundle.collateral_ref });
      this.event(loanId, "disbursed", amount, disbursed.txHash, { to: agent.address });
    });
    return this.view(this.get(loanId));
  }

  /** Money received for an open loan (repayment or a private enterprise sale). The rest is surplus. */
  applyPayment(loanId: string, amount: bigint, kind: "repayment" | "enterprise_sale", tx: string, detail?: Record<string, unknown>) {
    return this.db.transaction(() => {
      const loan = this.get(loanId);
      if (loan.status !== "open") {
        this.event(loanId, `${kind}_after_close`, amount, tx, detail);
        return { applied: 0n, surplus: amount, loan };
      }
      const outstanding = this.outstanding(loan);
      const applied = amount < outstanding ? amount : outstanding;
      this.db.run("UPDATE loans SET repaid_units = ? WHERE id = ?", (BigInt(loan.repaid_units) + applied).toString(), loanId);
      this.event(loanId, kind, applied, tx, detail);
      if (applied === outstanding) {
        this.db.run("UPDATE loans SET status = 'repaid', closed_at = ? WHERE id = ?", Date.now(), loanId);
        this.db.run("UPDATE bundles SET status = 'released' WHERE id = ? AND status = 'pledged'", loan.bundle_id);
        this.event(loanId, "collateral_released");
      }
      return { applied, surplus: amount - applied, loan: this.get(loanId) };
    });
  }

  /** Proceeds from a published (defaulted) bundle: cover the debt, the rest per DEFAULT_SURPLUS_TO. Selling continues. */
  applyRecovery(loanId: string, amount: bigint, tx: string, detail?: Record<string, unknown>) {
    return this.db.transaction(() => {
      const loan = this.get(loanId);
      if (loan.status !== "defaulted") throw new Error(`Loan ${loanId} is ${loan.status}, not defaulted`);
      const outstanding = this.outstanding(loan);
      const applied = amount < outstanding ? amount : outstanding;
      if (applied > 0n) this.db.run("UPDATE loans SET repaid_units = ? WHERE id = ?", (BigInt(loan.repaid_units) + applied).toString(), loanId);
      this.event(loanId, "recovery_sale", applied, tx, { ...detail, gross: fromUnits(amount) });
      if (outstanding > 0n && applied === outstanding) this.event(loanId, "debt_recovered");
      const surplus = amount - applied;
      return { applied, toUser: this.config.defaultSurplusTo === "user" ? surplus : 0n, toPlatform: this.config.defaultSurplusTo === "platform" ? surplus : 0n };
    });
  }

  /** Loans past their deadline with money owed default; their chats are published on CARSEM. */
  checkDefaults(now = Date.now()) {
    const overdue = this.db.all<LoanRow>("SELECT * FROM loans WHERE status = 'open' AND deadline < ?", now);
    for (const loan of overdue) {
      this.db.transaction(() => {
        this.db.run("UPDATE loans SET status = 'defaulted', closed_at = ? WHERE id = ? AND status = 'open'", now, loan.id);
        this.db.run("UPDATE bundles SET status = 'published' WHERE id = ?", loan.bundle_id);
        this.event(loan.id, "defaulted", this.outstanding(loan), undefined, { publishedBundle: loan.bundle_id });
      });
      console.log(`[lending] ${loan.id} defaulted with ${fromUnits(this.outstanding(loan))} USDM outstanding; bundle ${loan.bundle_id} published`);
    }
    return overdue.map(loan => loan.id);
  }

  openLoanFor(userId: string) {
    return this.db.get<LoanRow>("SELECT * FROM loans WHERE user_id = ? AND status = 'open'", userId);
  }

  creditUser(userId: string, amount: bigint) {
    if (amount <= 0n) return;
    const user = this.users.get(userId);
    this.db.run("UPDATE users SET earnings_units = ? WHERE id = ?", (BigInt(user.earnings_units) + amount).toString(), userId);
  }
}

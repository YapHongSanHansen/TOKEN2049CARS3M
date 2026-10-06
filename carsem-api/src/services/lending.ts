/**
 * CARSEM Lending — our contribution (Masumi has no lending primitive).
 *
 * MVP design: an off-chain loan ledger with on-chain money movements.
 *   borrow   treasury -> agent transfer (tx metadata carries loan id + collateral_ref)
 *   repay    an x402 payment of the outstanding amount to the treasury
 *   sale     enterprise purchases of the pledged bundle repay the loan
 *   default  past the deadline with a balance left -> bundle listed on the market
 */
import { fromUnits } from "@carsem/shared";
import type { Chain } from "../chain/index.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import { verifyAgentIdentity } from "./identity.js";
import type { AgentRow, BundleRow, ConsentRow, Users } from "./users.js";

export interface LoanRow {
  id: string; agent_id: string; user_id: string; amount_units: string; fee_units: string; repaid_units: string;
  deadline: number | null; status: "disbursing" | "open" | "repaid" | "defaulted"; collateral_ref: string; bundle_id: string;
  disburse_tx: string | null; created_at: number; closed_at: number | null;
}

export class Lending {
  constructor(private readonly db: Db, private readonly config: Config, private readonly chain: Chain, private readonly users: Users) {}

  fee(amount: bigint) { return (amount * this.config.loanFeeBps + 9_999n) / 10_000n; }

  terms() {
    return {
      asset: this.config.usdmAsset,
      maxAmount: fromUnits(this.config.loanMax),
      feeBps: Number(this.config.loanFeeBps),
      deadlineSeconds: this.config.loanDeadlineMs / 1000,
      collateral: "rights to the owner's redacted chat bundle",
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
    return {
      id: loan.id,
      agentId: loan.agent_id,
      userId: loan.user_id,
      status: loan.status,
      amount: fromUnits(loan.amount_units),
      fee: fromUnits(loan.fee_units),
      repaid: fromUnits(loan.repaid_units),
      outstanding: fromUnits(this.outstanding(loan)),
      totalDue: fromUnits(BigInt(loan.amount_units) + BigInt(loan.fee_units)),
      asset: this.config.usdmAsset,
      deadline: loan.deadline ? new Date(loan.deadline).toISOString() : null,
      secondsLeft: loan.deadline && loan.status === "open" ? Math.max(0, Math.round((loan.deadline - Date.now()) / 1000)) : null,
      collateralRef: loan.collateral_ref,
      bundleId: loan.bundle_id,
      disburseTx: loan.disburse_tx && { hash: loan.disburse_tx, explorerUrl: this.chain.explorerTx(loan.disburse_tx) },
      repayUrl: loan.status === "open" ? `${this.config.publicUrl}/loans/${loan.id}/repay` : null,
      createdAt: new Date(loan.created_at).toISOString(),
      closedAt: loan.closed_at ? new Date(loan.closed_at).toISOString() : null,
      events: events.map(e => ({
        kind: e.kind, amount: e.amount_units && fromUnits(e.amount_units), at: new Date(e.created_at).toISOString(),
        tx: e.tx && { hash: e.tx, explorerUrl: this.chain.explorerTx(e.tx) }, ...(e.detail_json ? JSON.parse(e.detail_json) : {}),
      })),
    };
  }

  list(filter: { agentId?: string; userId?: string; status?: string } = {}) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.agentId) { clauses.push("agent_id = ?"); params.push(filter.agentId); }
    if (filter.userId) { clauses.push("user_id = ?"); params.push(filter.userId); }
    if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
    return this.db.all<LoanRow>(`SELECT * FROM loans ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 100`, ...params)
      .map(loan => this.view(loan));
  }

  private event(loanId: string, kind: string, amount?: bigint, tx?: string, detail?: Record<string, unknown>) {
    this.db.run("INSERT INTO loan_events (loan_id, kind, amount_units, tx, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      loanId, kind, amount?.toString() ?? null, tx ?? null, detail ? JSON.stringify(detail) : null, Date.now());
  }

  async borrow(agent: AgentRow, amount: bigint) {
    if (amount <= 0n) throw new HttpError(400, "amount must be positive");
    if (amount > this.config.loanMax) throw new HttpError(400, `amount exceeds the ${fromUnits(this.config.loanMax)} tUSDM limit`);
    const identity = await verifyAgentIdentity(this.config, agent);
    if (!identity.ok) throw new HttpError(403, `Agent identity check failed: ${identity.reason}`);
    const fee = this.fee(amount);
    const loanId = newId("loan");

    // Claim the user's single loan slot and pledge the bundle atomically.
    const bundle = this.db.transaction(() => {
      const consent = this.db.get<ConsentRow>("SELECT * FROM consents WHERE user_id = ?", agent.owner_user_id);
      if (!consent || consent.status !== "active" || !consent.bundle_id) throw new HttpError(403, "The agent's owner has not opted in to borrowing against their redacted data.");
      if (consent.agent_id && consent.agent_id !== agent.id) throw new HttpError(403, `The owner's consent covers agent ${consent.agent_id}, not ${agent.id}.`);
      if (this.db.get("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('disbursing','open')", agent.owner_user_id)) {
        throw new HttpError(409, "There is already an open loan against this user's data. Repay it first.");
      }
      const bundle = this.db.get<BundleRow>("SELECT * FROM bundles WHERE id = ?", consent.bundle_id);
      if (!bundle || bundle.status !== "held") throw new HttpError(409, `The collateral bundle is not available (status ${bundle?.status ?? "missing"}).`);
      this.db.run("INSERT INTO loans (id, agent_id, user_id, amount_units, fee_units, status, collateral_ref, bundle_id, created_at) VALUES (?, ?, ?, ?, ?, 'disbursing', ?, ?, ?)",
        loanId, agent.id, agent.owner_user_id, amount.toString(), fee.toString(), bundle.collateral_ref, bundle.id, Date.now());
      this.db.run("UPDATE bundles SET status = 'pledged' WHERE id = ?", bundle.id);
      return bundle;
    });

    let disbursed;
    try {
      disbursed = await this.chain.transfer("treasury", agent.address, this.config.usdmAsset, amount,
        { msg: ["CARSEM loan disbursement", loanId, bundle.collateral_ref] });
    } catch (error) {
      this.db.transaction(() => {
        this.db.run("DELETE FROM loans WHERE id = ?", loanId);
        this.db.run("UPDATE bundles SET status = 'held' WHERE id = ?", bundle.id);
      });
      throw new HttpError(502, `Disbursement failed: ${(error as Error).message}`);
    }
    // The clock starts when the money is on chain, not when the request arrived.
    const deadline = Date.now() + this.config.loanDeadlineMs;
    this.db.transaction(() => {
      this.db.run("UPDATE loans SET status = 'open', deadline = ?, disburse_tx = ? WHERE id = ?", deadline, disbursed.txHash, loanId);
      this.event(loanId, "disbursed", amount, disbursed.txHash, { to: agent.address });
    });
    return this.view(this.get(loanId));
  }

  /**
   * Applies money received for a loan (repayment or bundle-sale proceeds).
   * Returns how much went to the loan; the rest is surplus for the caller to route.
   */
  applyPayment(loanId: string, amount: bigint, kind: "repayment" | "bundle_sale", tx: string, detail?: Record<string, unknown>) {
    return this.db.transaction(() => {
      const loan = this.get(loanId);
      if (loan.status !== "open") {
        this.event(loanId, `${kind}_after_close`, amount, tx, detail);
        return { applied: 0n, surplus: amount, loan };
      }
      const outstanding = this.outstanding(loan);
      const applied = amount < outstanding ? amount : outstanding;
      const repaid = BigInt(loan.repaid_units) + applied;
      this.db.run("UPDATE loans SET repaid_units = ? WHERE id = ?", repaid.toString(), loanId);
      this.event(loanId, kind, applied, tx, detail);
      if (applied === outstanding) {
        this.db.run("UPDATE loans SET status = 'repaid', closed_at = ? WHERE id = ?", Date.now(), loanId);
        // Collateral released: the bundle goes back to the owner, still under their consent.
        this.db.run("UPDATE bundles SET status = 'held' WHERE id = ? AND status = 'pledged'", loan.bundle_id);
        this.event(loanId, "collateral_released");
      }
      return { applied, surplus: amount - applied, loan: this.get(loanId) };
    });
  }

  /**
   * Proceeds from selling a defaulted loan's bundle. They cover the debt first;
   * once it is covered the bundle comes off the market, and the surplus belongs
   * to the data owner (the caller credits it). Liquidation never exceeds the debt.
   */
  applyRecovery(loanId: string, amount: bigint, tx: string, detail?: Record<string, unknown>) {
    return this.db.transaction(() => {
      const loan = this.get(loanId);
      if (loan.status !== "defaulted") throw new Error(`Loan ${loanId} is ${loan.status}, not defaulted`);
      const outstanding = this.outstanding(loan);
      const applied = amount < outstanding ? amount : outstanding;
      if (applied > 0n) this.db.run("UPDATE loans SET repaid_units = ? WHERE id = ?", (BigInt(loan.repaid_units) + applied).toString(), loanId);
      this.event(loanId, "recovery_sale", applied, tx, { ...detail, gross: fromUnits(amount) });
      if (outstanding > 0n && applied === outstanding) {
        this.db.run("UPDATE bundles SET status = 'held' WHERE id = ? AND status = 'listed'", loan.bundle_id);
        this.event(loanId, "debt_recovered");
        this.event(loanId, "collateral_released");
      }
      return { applied, surplus: amount - applied };
    });
  }

  /** Loans past their deadline with money still owed default; their bundles go on sale. */
  checkDefaults(now = Date.now()) {
    const overdue = this.db.all<LoanRow>("SELECT * FROM loans WHERE status = 'open' AND deadline < ?", now);
    for (const loan of overdue) {
      this.db.transaction(() => {
        this.db.run("UPDATE loans SET status = 'defaulted', closed_at = ? WHERE id = ? AND status = 'open'", now, loan.id);
        this.db.run("UPDATE bundles SET status = 'listed' WHERE id = ?", loan.bundle_id);
        this.event(loan.id, "defaulted", this.outstanding(loan), undefined, { listedBundle: loan.bundle_id });
      });
      console.log(`[lending] ${loan.id} defaulted with ${fromUnits(this.outstanding(loan))} tUSDM outstanding; bundle ${loan.bundle_id} listed`);
    }
    return overdue.map(loan => loan.id);
  }

  /** Opens loans in the agent's or users' view. */
  openLoanFor(userId: string) {
    return this.db.get<LoanRow>("SELECT * FROM loans WHERE user_id = ? AND status = 'open'", userId);
  }

  creditUser(userId: string, amount: bigint) {
    if (amount <= 0n) return;
    const user = this.users.get(userId);
    this.db.run("UPDATE users SET earnings_units = ? WHERE id = ?", (BigInt(user.earnings_units) + amount).toString(), userId);
  }
}

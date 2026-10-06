/**
 * Enterprise data marketplace. Bundles are sold redacted, via x402:
 *   - pledged bundles (loan open, owner allowed it): proceeds repay the loan,
 *     the surplus is credited to the data owner;
 *   - listed bundles (loan defaulted): proceeds are CARSEM's recovery.
 */
import { fromUnits, toUnits } from "@carsem/shared";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { Lending, LoanRow } from "./lending.js";
import { displayLine } from "./redaction.js";
import type { BundleRow, Users } from "./users.js";

export interface BidRow { id: string; enterprise: string; price_usdm: number; data_amount: number }

export class Market {
  constructor(private readonly db: Db, private readonly config: Config, private readonly users: Users, private readonly lending: Lending) {}

  bids() {
    return this.db.all<BidRow>("SELECT * FROM bids ORDER BY price_usdm DESC")
      .map(b => ({ id: b.id, enterprise: b.enterprise, priceUsdm: b.price_usdm, dataAmount: b.data_amount }));
  }

  bid(id: string): BidRow {
    const bid = this.db.get<BidRow>("SELECT * FROM bids WHERE id = ? OR lower(enterprise) = lower(?)", id, id);
    if (!bid) throw new HttpError(404, `No bid ${id}`);
    return bid;
  }

  price(bid: BidRow) { return toUnits(bid.price_usdm.toFixed(6)); }

  private loanOf(bundle: BundleRow) {
    return this.db.get<LoanRow>("SELECT * FROM loans WHERE bundle_id = ? ORDER BY created_at DESC LIMIT 1", bundle.id);
  }

  private saleable(bundle: BundleRow) {
    if (bundle.status === "listed") return true;
    if (bundle.status !== "pledged") return false;
    const consent = this.db.get<{ allow_sale_while_open: number }>("SELECT allow_sale_while_open FROM consents WHERE user_id = ?", bundle.user_id);
    return consent?.allow_sale_while_open === 1;
  }

  listings() {
    const bids = this.bids();
    return this.db.all<BundleRow>("SELECT * FROM bundles WHERE status IN ('pledged','listed') ORDER BY created_at DESC")
      .filter(bundle => this.saleable(bundle))
      .map(bundle => {
        const loan = this.loanOf(bundle);
        const sold = this.db.all<{ bid_id: string }>("SELECT bid_id FROM sales WHERE bundle_id = ?", bundle.id).map(s => s.bid_id);
        return {
          id: bundle.id,
          status: bundle.status,
          reason: bundle.status === "listed" ? "loan defaulted" : "loan open; owner allows sale to repay it",
          collateralRef: bundle.collateral_ref,
          stats: JSON.parse(bundle.stats_json),
          preview: JSON.parse(bundle.preview_json).slice(0, 2),
          loan: loan && { id: loan.id, status: loan.status, outstanding: fromUnits(this.lending.outstanding(loan)) },
          offers: bids.filter(b => !sold.includes(b.id)).map(b => ({ bidId: b.id, enterprise: b.enterprise, price: b.priceUsdm, buyUrl: `${this.config.publicUrl}/market/bundles/${bundle.id}/buy?bid=${b.id}` })),
          soldTo: bids.filter(b => sold.includes(b.id)).map(b => b.enterprise),
        };
      });
  }

  /** Throws unless `bidId` may buy `bundleId` now. */
  assertBuyable(bundleId: string, bidId: string) {
    const bundle = this.users.bundle(bundleId);
    const bid = this.bid(bidId);
    if (!this.saleable(bundle)) throw new HttpError(409, `Bundle ${bundleId} is not for sale (status ${bundle.status})`);
    if (this.db.get("SELECT 1 FROM sales WHERE bundle_id = ? AND bid_id = ?", bundleId, bid.id)) throw new HttpError(409, `${bid.enterprise} already bought bundle ${bundleId}`);
    return { bundle, bid };
  }

  /** What the buyer receives: the redacted bundle, never raw chats. */
  deliverable(bundleId: string) {
    const contents = this.users.bundleContents(bundleId);
    return { bundleId, version: contents.version, stats: contents.stats, messages: contents.messages.filter(m => !m.withheld).map(displayLine) };
  }

  /** Settlement effect of a purchase: record it and route the proceeds. */
  recordSale(bundleId: string, bidId: string, buyer: string | undefined, paymentTx: string) {
    const { bundle, bid } = { bundle: this.users.bundle(bundleId), bid: this.bid(bidId) };
    const price = this.price(bid);
    const saleId = newId("sale");
    const inserted = this.db.run(
      "INSERT INTO sales (id, bundle_id, bid_id, buyer, price_units, payment_tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      saleId, bundleId, bid.id, buyer ?? null, price.toString(), paymentTx, Date.now());
    if (inserted.changes === 0) return;
    const loan = this.loanOf(bundle);
    let applied = 0n;
    let toUser = 0n;
    if (loan && loan.status === "open") {
      const result = this.lending.applyPayment(loan.id, price, "bundle_sale", paymentTx, { enterprise: bid.enterprise, saleId });
      applied = result.applied;
      toUser = result.surplus;
      this.lending.creditUser(bundle.user_id, toUser);
    } else if (loan && loan.status === "defaulted") {
      const result = this.lending.applyRecovery(loan.id, price, paymentTx, { enterprise: bid.enterprise, saleId });
      applied = result.applied;
      toUser = result.surplus;
      this.lending.creditUser(bundle.user_id, toUser);
    }
    this.db.run("UPDATE sales SET loan_id = ?, applied_to_loan_units = ?, to_user_units = ? WHERE id = ?", loan?.id ?? null, applied.toString(), toUser.toString(), saleId);
  }

  sales() {
    return this.db.all<{ id: string; bundle_id: string; bid_id: string; enterprise: string; buyer: string | null; price_units: string; payment_tx: string; loan_id: string | null; applied_to_loan_units: string; to_user_units: string; created_at: number }>(
      "SELECT s.*, b.enterprise FROM sales s JOIN bids b ON b.id = s.bid_id ORDER BY s.created_at DESC LIMIT 100")
      .map(s => ({
        id: s.id, bundleId: s.bundle_id, bidId: s.bid_id, enterprise: s.enterprise, buyer: s.buyer, price: fromUnits(s.price_units), paymentTx: s.payment_tx,
        loanId: s.loan_id, appliedToLoan: fromUnits(s.applied_to_loan_units), toUser: fromUnits(s.to_user_units), at: new Date(s.created_at).toISOString(),
      }));
  }
}

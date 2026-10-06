/**
 * The data market, two channels, both paid over x402:
 *   enterprise  private: while a loan is open (if the owner allows it), enterprises buy the
 *               pledged bundle at their bid as the "collateral lending backend";
 *               proceeds repay the loan and the rest goes to the owner
 *   public      after a default the bundle is published: any CARSEM user can access it for
 *               a fee, enterprises can still buy, and it keeps selling; proceeds cover the
 *               debt first, then go to the platform (DEFAULT_SURPLUS_TO)
 */
import { fromUnits, toUnits } from "@carsem/shared";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { Lending, LoanRow } from "./lending.js";
import type { BundleRow, Sync } from "./sync.js";
import type { UserRow, Users } from "./users.js";

export interface BidRow { id: string; enterprise: string; price_usdm: number; data_amount: number }

export class Market {
  constructor(private readonly db: Db, private readonly config: Config, private readonly users: Users, private readonly sync: Sync, private readonly lending: Lending) {}

  bids() {
    return this.db.all<BidRow>("SELECT * FROM bids ORDER BY price_usdm DESC")
      .map(b => ({ id: b.id, enterprise: b.enterprise, priceUsdm: b.price_usdm, dataAmount: b.data_amount }));
  }

  bid(id: string): BidRow {
    const bid = this.db.get<BidRow>("SELECT * FROM bids WHERE id = ? OR lower(enterprise) = lower(?)", id, id);
    if (!bid) throw new HttpError(404, `No bid ${id}`);
    return bid;
  }

  bidPrice(bid: BidRow) { return toUnits(bid.price_usdm.toFixed(6)); }

  private loanOf(bundle: BundleRow) {
    return this.db.get<LoanRow>("SELECT * FROM loans WHERE bundle_id = ?", bundle.id);
  }

  private enterpriseSaleAllowed(bundle: BundleRow) {
    if (bundle.status === "published") return true;
    if (bundle.status !== "pledged") return false;
    return this.users.consentOf(bundle.user_id)?.allow_sale_while_open === 1;
  }

  listings(viewer?: UserRow) {
    const bids = this.bids();
    return this.db.all<BundleRow>("SELECT * FROM bundles WHERE status IN ('pledged','published') ORDER BY created_at DESC")
      .filter(bundle => this.enterpriseSaleAllowed(bundle))
      .map(bundle => {
        const loan = this.loanOf(bundle);
        const soldTo = this.db.all<{ bid_id: string }>("SELECT bid_id FROM sales WHERE bundle_id = ? AND bid_id IS NOT NULL", bundle.id).map(s => s.bid_id);
        const publicBuyers = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sales WHERE bundle_id = ? AND channel = 'public'", bundle.id)!.n;
        const owned = viewer && this.db.get("SELECT 1 FROM sales WHERE bundle_id = ? AND buyer_user_id = ?", bundle.id, viewer.id);
        return {
          id: bundle.id,
          status: bundle.status,
          reason: bundle.status === "published" ? "loan defaulted: published for every CARSEM user" : "loan open: private sale to enterprises repays it",
          collateralRef: bundle.collateral_ref,
          stats: JSON.parse(bundle.stats_json),
          preview: JSON.parse(bundle.preview_json).slice(0, 2),
          loan: loan && { id: loan.id, status: loan.status, outstanding: fromUnits(this.lending.outstanding(loan)) },
          enterpriseOffers: bids.filter(b => !soldTo.includes(b.id)).map(b => ({ bidId: b.id, enterprise: b.enterprise, price: b.priceUsdm })),
          soldTo: bids.filter(b => soldTo.includes(b.id)).map(b => b.enterprise),
          publicAccess: bundle.status === "published"
            ? { price: fromUnits(this.config.publicAccessPrice), buyers: publicBuyers, accessUrl: `${this.config.publicUrl}/market/bundles/${bundle.id}/access`, youOwnIt: !!owned, isYours: viewer?.id === bundle.user_id }
            : null,
        };
      });
  }

  assertEnterpriseBuyable(bundleId: string, bidId: string) {
    const bundle = this.sync.bundle(bundleId);
    const bid = this.bid(bidId);
    if (!this.enterpriseSaleAllowed(bundle)) throw new HttpError(409, `Bundle ${bundleId} is not for sale to enterprises (status ${bundle.status})`);
    if (this.db.get("SELECT 1 FROM sales WHERE bundle_id = ? AND bid_id = ?", bundleId, bid.id)) throw new HttpError(409, `${bid.enterprise} already bought bundle ${bundleId}`);
    return { bundle, bid };
  }

  assertPublicAccess(bundleId: string, user: UserRow) {
    this.users.requireOnboarded(user);
    const bundle = this.sync.bundle(bundleId);
    if (bundle.status !== "published") throw new HttpError(409, `Bundle ${bundleId} is not published (only defaulted collateral is)`);
    if (bundle.user_id === user.id) throw new HttpError(409, "This is your own data");
    if (this.db.get("SELECT 1 FROM sales WHERE bundle_id = ? AND buyer_user_id = ?", bundleId, user.id)) throw new HttpError(409, "You already have access to this bundle");
    return bundle;
  }

  /** Routes the proceeds of any sale to the loan, the owner and the platform. */
  private settle(bundle: BundleRow, saleId: string, price: bigint, paymentTx: string, detail: Record<string, unknown>) {
    const loan = this.loanOf(bundle);
    let applied = 0n, toUser = 0n, toPlatform = 0n;
    if (loan?.status === "open") {
      const result = this.lending.applyPayment(loan.id, price, "enterprise_sale", paymentTx, { ...detail, saleId });
      applied = result.applied;
      toUser = result.surplus;
    } else if (loan?.status === "defaulted") {
      ({ applied, toUser, toPlatform } = this.lending.applyRecovery(loan.id, price, paymentTx, { ...detail, saleId }));
    } else {
      toUser = price;
    }
    this.lending.creditUser(bundle.user_id, toUser);
    this.db.run("UPDATE sales SET loan_id = ?, applied_to_loan_units = ?, to_user_units = ?, to_platform_units = ? WHERE id = ?",
      loan?.id ?? null, applied.toString(), toUser.toString(), toPlatform.toString(), saleId);
  }

  recordEnterpriseSale(bundleId: string, bidId: string, buyer: string | undefined, paymentTx: string) {
    const bundle = this.sync.bundle(bundleId);
    const bid = this.bid(bidId);
    const price = this.bidPrice(bid);
    const saleId = newId("sale");
    const inserted = this.db.run("INSERT INTO sales (id, bundle_id, channel, bid_id, buyer, price_units, payment_tx, created_at) VALUES (?, ?, 'enterprise', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      saleId, bundleId, bid.id, buyer ?? null, price.toString(), paymentTx, Date.now());
    if (inserted.changes) this.settle(bundle, saleId, price, paymentTx, { enterprise: bid.enterprise });
  }

  recordPublicSale(bundleId: string, buyerUserId: string, buyer: string | undefined, paymentTx: string) {
    const bundle = this.sync.bundle(bundleId);
    const price = this.config.publicAccessPrice;
    const saleId = newId("sale");
    const inserted = this.db.run("INSERT INTO sales (id, bundle_id, channel, buyer_user_id, buyer, price_units, payment_tx, created_at) VALUES (?, ?, 'public', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      saleId, bundleId, buyerUserId, buyer ?? null, price.toString(), paymentTx, Date.now());
    if (inserted.changes) this.settle(bundle, saleId, price, paymentTx, { channel: "public", buyerUserId });
  }

  sales() {
    return this.db.all<{ id: string; bundle_id: string; channel: string; bid_id: string | null; enterprise: string | null; buyer_user_id: string | null; buyer: string | null; price_units: string; payment_tx: string; loan_id: string | null; applied_to_loan_units: string; to_user_units: string; to_platform_units: string; created_at: number }>(
      "SELECT s.*, b.enterprise FROM sales s LEFT JOIN bids b ON b.id = s.bid_id ORDER BY s.created_at DESC LIMIT 100")
      .map(s => ({
        id: s.id, bundleId: s.bundle_id, channel: s.channel, enterprise: s.enterprise, buyerUserId: s.buyer_user_id, buyer: s.buyer,
        price: fromUnits(s.price_units), paymentTx: s.payment_tx, loanId: s.loan_id, appliedToLoan: fromUnits(s.applied_to_loan_units),
        toUser: fromUnits(s.to_user_units), toPlatform: fromUnits(s.to_platform_units), at: new Date(s.created_at).toISOString(),
      }));
  }
}

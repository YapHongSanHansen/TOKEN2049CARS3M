/**
 * CARSEM's data platform: trading signals for Cardano DEX tokens, and live
 * flight / hotel / product prices. Data is uploaded by users and not validated;
 * an uploader's reputation grows from outcomes (signals, via trades) and buyer
 * ratings. Every paid delivery is bound to its request and payment by a hash,
 * logged on chain (decision log / proof of delivery).
 */
import { canonicalJson, fromUnits, sha256Hex, toUnits } from "@carsem/shared";
import type { Chain } from "../chain/index.js";
import { CATEGORIES, type Category, type Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { UserRow } from "./users.js";

export interface ListingRow {
  id: string; category: Category; subject: string; title: string; payload_json: string; uploader_id: string;
  price_units: string; created_at: number; outcome: "hit" | "miss" | null;
}
export interface DeliveryRow {
  id: string; listing_id: string; buyer_user_id: string | null; buyer_address: string | null; payment_tx: string; request_json: string;
  delivery_hash: string; log_tx: string | null; log_status: string; job_id: string | null; traded: number; rating: number | null; created_at: number;
}

/** Normalised lookup key per category. */
export function subjectOf(category: Category, payload: Record<string, unknown>): string {
  const norm = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  switch (category) {
    case "signal": return norm(payload.token);
    case "flight": return `${norm(payload.from)}-${norm(payload.to)}`;
    case "hotel": return `${norm(payload.city)}${payload.area ? `/${norm(payload.area)}` : ""}`;
    case "product": return norm(payload.name);
  }
}

const REQUIRED: Record<Category, string[]> = {
  signal: ["token", "direction", "confidence", "rationale"],
  flight: ["from", "to", "airline", "price", "currency"],
  hotel: ["city", "name", "pricePerNight", "currency"],
  product: ["name", "store", "price", "currency"],
};

export class DataPlatform {
  constructor(private readonly db: Db, private readonly config: Config, private readonly chain: Chain) {}

  category(value: unknown): Category {
    const category = String(value ?? "").toLowerCase().replace(/s$/, "") as Category;
    if (!CATEGORIES.includes(category)) throw new HttpError(400, `category must be one of ${CATEGORIES.join(", ")}`);
    return category;
  }

  categories() {
    return CATEGORIES.map(category => ({
      category, price: fromUnits(this.config.prices[category]), asset: this.config.usdmAsset,
      listings: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM listings WHERE category = ?", category)!.n,
    }));
  }

  /** Free search: what is for sale, at what price, from whom. The payload stays behind the paywall. */
  search(category: Category, query = "", limit = 10) {
    const q = `%${query.trim().toUpperCase()}%`;
    return this.db.all<ListingRow & { uploader_name: string; reputation: number }>(
      `SELECT l.*, u.name AS uploader_name, u.reputation FROM listings l JOIN uploaders u ON u.id = l.uploader_id
       WHERE l.category = ? AND (UPPER(l.subject) LIKE ? OR UPPER(l.title) LIKE ?)
       ORDER BY l.created_at DESC, u.reputation DESC LIMIT ?`, category, q, q, limit)
      .map(l => ({
        id: l.id, category: l.category, subject: l.subject, title: l.title, price: fromUnits(l.price_units),
        uploader: { name: l.uploader_name, reputation: Number(l.reputation.toFixed(3)) }, publishedAt: new Date(l.created_at).toISOString(),
        validated: false, buyUrl: `${this.config.publicUrl}/data/listings/${l.id}`,
      }));
  }

  listing(id: string): ListingRow & { uploader_name: string; reputation: number } {
    const listing = this.db.get<ListingRow & { uploader_name: string; reputation: number }>(
      "SELECT l.*, u.name AS uploader_name, u.reputation FROM listings l JOIN uploaders u ON u.id = l.uploader_id WHERE l.id = ?", id);
    if (!listing) throw new HttpError(404, `No listing ${id}`);
    return listing;
  }

  /** The full listing a buyer receives. */
  publicListing(listing: ListingRow & { uploader_name: string; reputation: number }) {
    return {
      id: listing.id, category: listing.category, subject: listing.subject, title: listing.title, data: JSON.parse(listing.payload_json),
      publishedAt: new Date(listing.created_at).toISOString(), validated: false,
      uploader: { id: listing.uploader_id, name: listing.uploader_name, reputation: Number(listing.reputation.toFixed(3)) },
    };
  }

  /** A user uploads data (signals or prices). Not validated; reputation does the filtering over time. */
  upload(user: UserRow, input: { category?: unknown; title?: unknown; data?: unknown; price?: unknown }) {
    const category = this.category(input.category);
    const data = input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data as Record<string, unknown> : undefined;
    if (!data) throw new HttpError(400, "data must be an object");
    const missing = REQUIRED[category].filter(k => data[k] === undefined || data[k] === "");
    if (missing.length) throw new HttpError(400, `A ${category} needs: ${missing.join(", ")}`);
    if (category === "signal" && !["long", "short"].includes(String(data.direction))) throw new HttpError(400, "direction must be long or short");
    if (JSON.stringify(data).length > 4000) throw new HttpError(400, "data is too large");
    const price = input.price === undefined ? this.config.prices[category] : toUnits(String(input.price));
    if (price <= 0n || price > toUnits("50")) throw new HttpError(400, "price must be between 0 and 50 USDM");
    let uploader = this.db.get<{ id: string }>("SELECT id FROM uploaders WHERE user_id = ?", user.id);
    if (!uploader) {
      uploader = { id: newId("upl") };
      this.db.run("INSERT INTO uploaders (id, name, user_id) VALUES (?, ?, ?)", uploader.id, user.name, user.id);
    }
    const subject = subjectOf(category, data);
    const id = newId(category.slice(0, 3));
    const title = String(input.title ?? "").trim().slice(0, 120) || `${category} ${subject}`;
    this.db.run("INSERT INTO listings (id, category, subject, title, payload_json, uploader_id, price_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, category, subject, title, JSON.stringify(data), uploader.id, price.toString(), Date.now());
    return { id, category, subject, title, price: fromUnits(price), validated: false };
  }

  deliveryHash(request: Record<string, unknown>, listing: Record<string, unknown>) {
    return sha256Hex(canonicalJson({ request, listing }));
  }

  /** Records a settled delivery, then writes its hash on chain in the background (decision log). */
  recordDelivery(input: { deliveryId: string; listingId: string; buyerUserId?: string; buyerAddress?: string; paymentTx: string; request: Record<string, unknown>; deliveryHash: string; jobId?: string }) {
    const inserted = this.db.run(
      `INSERT INTO deliveries (id, listing_id, buyer_user_id, buyer_address, payment_tx, request_json, delivery_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (payment_tx) DO NOTHING`,
      input.deliveryId, input.listingId, input.buyerUserId ?? null, input.buyerAddress ?? null, input.paymentTx, JSON.stringify(input.request), input.deliveryHash, input.jobId ?? null, Date.now());
    if (inserted.changes === 0) return;
    if (input.jobId) this.db.run("UPDATE jobs SET status = 'completed', delivery_id = ? WHERE id = ?", input.deliveryId, input.jobId);
    void this.chain.logDecision(["CARSEM data delivery v1", input.deliveryHash, input.paymentTx])
      .then(({ txHash }) => this.db.run("UPDATE deliveries SET log_tx = ?, log_status = 'confirmed' WHERE id = ?", txHash, input.deliveryId))
      .catch(error => {
        console.error(`[data] decision log for ${input.deliveryId} failed:`, (error as Error).message);
        this.db.run("UPDATE deliveries SET log_status = 'failed' WHERE id = ?", input.deliveryId);
      });
  }

  delivery(idOrHash: string): DeliveryRow {
    const delivery = this.db.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ? OR delivery_hash = ? OR payment_tx = ?", idOrHash, idOrHash, idOrHash);
    if (!delivery) throw new HttpError(404, `No delivery ${idOrHash}`);
    return delivery;
  }

  deliveryView(d: DeliveryRow) {
    return {
      id: d.id, listingId: d.listing_id, buyerUserId: d.buyer_user_id, buyer: d.buyer_address, deliveryHash: d.delivery_hash,
      request: JSON.parse(d.request_json), payment: { hash: d.payment_tx, explorerUrl: this.chain.explorerTx(d.payment_tx) },
      decisionLog: { status: d.log_status, tx: d.log_tx && { hash: d.log_tx, explorerUrl: this.chain.explorerTx(d.log_tx) } },
      jobId: d.job_id, traded: d.traded === 1, rating: d.rating, at: new Date(d.created_at).toISOString(),
    };
  }

  private bumpReputation(uploaderId: string, hit: boolean) {
    this.db.run("UPDATE uploaders SET hits = hits + ?, misses = misses + ? WHERE id = ?", hit ? 1 : 0, hit ? 0 : 1, uploaderId);
    this.db.run("UPDATE uploaders SET reputation = (hits + 1.0) / (hits + misses + 2.0) WHERE id = ?", uploaderId);
  }

  /** A signal's trade outcome feeds its uploader's reputation. */
  markOutcome(listingId: string, outcome: "hit" | "miss") {
    this.db.transaction(() => {
      const listing = this.listing(listingId);
      this.db.run("UPDATE listings SET outcome = ? WHERE id = ?", outcome, listingId);
      this.bumpReputation(listing.uploader_id, outcome === "hit");
    });
  }

  /** The buyer rates a delivery once (useful or not); it feeds the uploader's reputation. */
  rate(user: UserRow, deliveryId: string, useful: boolean) {
    return this.db.transaction(() => {
      const delivery = this.delivery(deliveryId);
      if (delivery.buyer_user_id !== user.id) throw new HttpError(403, "Only the buyer can rate a delivery");
      if (delivery.rating !== null) throw new HttpError(409, "Already rated");
      this.db.run("UPDATE deliveries SET rating = ? WHERE id = ?", useful ? 1 : 0, delivery.id);
      this.bumpReputation(this.listing(delivery.listing_id).uploader_id, useful);
      return { deliveryId: delivery.id, rating: useful ? "useful" : "not useful" };
    });
  }

  uploaders() {
    return this.db.all<{ id: string; name: string; reputation: number; hits: number; misses: number; listings: number }>(
      `SELECT u.id, u.name, u.reputation, u.hits, u.misses, COUNT(l.id) AS listings FROM uploaders u
       LEFT JOIN listings l ON l.uploader_id = u.id GROUP BY u.id ORDER BY u.reputation DESC, listings DESC`)
      .map(u => ({ ...u, reputation: Number(u.reputation.toFixed(3)) }));
  }

  newDeliveryId() { return newId("dlv"); }
}

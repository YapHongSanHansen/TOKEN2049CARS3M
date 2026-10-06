/**
 * The signal marketplace (seller side). A delivery is bound to its request and
 * payment by `delivery_hash`, and that hash is written on chain as a label-674
 * message: the decision log / proof of delivery.
 */
import { canonicalJson, sha256Hex } from "@carsem/shared";
import type { Chain } from "../chain/index.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";

export interface SignalRow {
  id: string; uploader_id: string; token: string; pair: string; direction: "long" | "short"; confidence: number;
  horizon_minutes: number; rationale: string; created_at: number; outcome: "hit" | "miss" | null;
}
export interface DeliveryRow {
  id: string; signal_id: string; buyer: string | null; payment_tx: string; request_json: string; delivery_hash: string;
  log_tx: string | null; log_status: string; job_id: string | null; traded: number; created_at: number;
}

export class Signals {
  constructor(private readonly db: Db, private readonly chain: Chain) {}

  tokens() {
    return this.db.all<{ token: string; pair: string; signals: number }>(
      "SELECT token, pair, COUNT(*) AS signals FROM signals GROUP BY token, pair ORDER BY token");
  }

  has(token: string) { return !!this.db.get("SELECT 1 FROM signals WHERE token = ?", token); }

  /** The freshest signal for `token`, best uploader reputation first on ties. */
  latest(token: string): SignalRow & { uploader_name: string; reputation: number } {
    const signal = this.db.get<SignalRow & { uploader_name: string; reputation: number }>(
      `SELECT s.*, u.name AS uploader_name, u.reputation FROM signals s JOIN uploaders u ON u.id = s.uploader_id
       WHERE s.token = ? ORDER BY s.created_at DESC, u.reputation DESC LIMIT 1`, token);
    if (!signal) throw new HttpError(404, `No signals for ${token}`);
    return signal;
  }

  publicSignal(signal: SignalRow & { uploader_name: string; reputation: number }) {
    return {
      id: signal.id, token: signal.token, pair: signal.pair, direction: signal.direction, confidence: signal.confidence,
      horizonMinutes: signal.horizon_minutes, rationale: signal.rationale, publishedAt: new Date(signal.created_at).toISOString(),
      uploader: { id: signal.uploader_id, name: signal.uploader_name, reputation: Number(signal.reputation.toFixed(3)) },
    };
  }

  deliveryHash(request: Record<string, unknown>, signal: Record<string, unknown>) {
    return sha256Hex(canonicalJson({ request, signal }));
  }

  /** Records a settled delivery, then writes its hash on chain in the background. */
  recordDelivery(input: { signalId: string; buyer?: string; paymentTx: string; request: Record<string, unknown>; deliveryHash: string; jobId?: string; deliveryId: string }) {
    const inserted = this.db.run(
      `INSERT INTO deliveries (id, signal_id, buyer, payment_tx, request_json, delivery_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (payment_tx) DO NOTHING`,
      input.deliveryId, input.signalId, input.buyer ?? null, input.paymentTx, JSON.stringify(input.request), input.deliveryHash, input.jobId ?? null, Date.now());
    if (inserted.changes === 0) return;
    if (input.jobId) this.db.run("UPDATE jobs SET status = 'completed', delivery_id = ? WHERE id = ?", input.deliveryId, input.jobId);
    void this.chain.logDecision(["CARSEM signal delivery v1", input.deliveryHash, input.paymentTx])
      .then(({ txHash }) => this.db.run("UPDATE deliveries SET log_tx = ?, log_status = 'confirmed' WHERE id = ?", txHash, input.deliveryId))
      .catch(error => {
        console.error(`[signals] decision log for ${input.deliveryId} failed:`, (error as Error).message);
        this.db.run("UPDATE deliveries SET log_status = 'failed' WHERE id = ?", input.deliveryId);
      });
  }

  delivery(idOrHash: string): DeliveryRow {
    const delivery = this.db.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ? OR delivery_hash = ? OR payment_tx = ?", idOrHash, idOrHash, idOrHash);
    if (!delivery) throw new HttpError(404, `No delivery ${idOrHash}`);
    return delivery;
  }

  deliveryView(delivery: DeliveryRow) {
    return {
      id: delivery.id, signalId: delivery.signal_id, buyer: delivery.buyer, deliveryHash: delivery.delivery_hash,
      request: JSON.parse(delivery.request_json),
      payment: { hash: delivery.payment_tx, explorerUrl: this.chain.explorerTx(delivery.payment_tx) },
      decisionLog: { status: delivery.log_status, tx: delivery.log_tx && { hash: delivery.log_tx, explorerUrl: this.chain.explorerTx(delivery.log_tx) } },
      jobId: delivery.job_id, traded: delivery.traded === 1, at: new Date(delivery.created_at).toISOString(),
    };
  }

  /** Marks a signal's outcome and updates its uploader's reputation (Laplace-smoothed hit rate). */
  markOutcome(signalId: string, outcome: "hit" | "miss") {
    this.db.transaction(() => {
      const signal = this.db.get<SignalRow>("SELECT * FROM signals WHERE id = ?", signalId);
      if (!signal) throw new HttpError(404, `No signal ${signalId}`);
      this.db.run("UPDATE signals SET outcome = ? WHERE id = ?", outcome, signalId);
      this.db.run(`UPDATE uploaders SET hits = hits + ?, misses = misses + ? WHERE id = ?`, outcome === "hit" ? 1 : 0, outcome === "miss" ? 1 : 0, signal.uploader_id);
      this.db.run("UPDATE uploaders SET reputation = (hits + 1.0) / (hits + misses + 2.0) WHERE id = ?", signal.uploader_id);
    });
  }

  uploaders() {
    return this.db.all<{ id: string; name: string; reputation: number; hits: number; misses: number; signals: number }>(
      `SELECT u.id, u.name, u.reputation, u.hits, u.misses, COUNT(s.id) AS signals FROM uploaders u
       LEFT JOIN signals s ON s.uploader_id = u.id GROUP BY u.id ORDER BY u.reputation DESC`)
      .map(u => ({ ...u, reputation: Number(u.reputation.toFixed(3)) }));
  }

  newDeliveryId() { return newId("dlv"); }
}

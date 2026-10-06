/**
 * DEX simulator — a stand-in for a Minswap preprod swap (@minswap/sdk) until
 * that is wired in. Every response says `simulated: true`.
 *
 * One trade per purchased signal: the fill follows the signal's direction, the
 * outcome is a deterministic draw weighted by the signal's confidence (or forced
 * by DEX_SIM_OUTCOME / the request, for demos), and a profit is paid to the agent
 * in tUSDM by the market-maker wallet. Losses are absorbed by the agent's
 * position; nothing is debited.
 */
import { fromUnits, sha256Hex, toUnits } from "@carsem/shared";
import type { Chain } from "../chain/index.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { DeliveryRow, SignalRow, Signals } from "./signals.js";

/** Indicative preprod prices in ADA. */
const PRICES_ADA: Record<string, number> = { MIN: 0.031, SNEK: 0.0021, INDY: 0.62, HOSKY: 0.0000004, DJED: 2.2, IUSD: 1.9 };

export class DexSimulator {
  constructor(private readonly db: Db, private readonly config: Config, private readonly chain: Chain, private readonly signals: Signals) {}

  async swap(input: { agentAddress: string; deliveryId: string; sizeAda: number; forceOutcome?: "win" | "loss" }) {
    if (!Number.isFinite(input.sizeAda) || input.sizeAda <= 0 || input.sizeAda > 100_000) throw new HttpError(400, "sizeAda must be between 0 and 100000");
    const delivery = this.signals.delivery(input.deliveryId);
    if (delivery.buyer && delivery.buyer !== input.agentAddress) throw new HttpError(403, "Only the buyer of a signal can trade it");
    const signal = this.db.get<SignalRow>("SELECT * FROM signals WHERE id = ?", delivery.signal_id)!;
    // Claim the delivery's single trade before any money moves.
    const claimed = this.db.run("UPDATE deliveries SET traded = 1 WHERE id = ? AND traded = 0", delivery.id);
    if (claimed.changes === 0) throw new HttpError(409, `Signal delivery ${delivery.id} was already traded`);
    try {
      return await this.fill(delivery, signal, input);
    } catch (error) {
      this.db.run("UPDATE deliveries SET traded = 0 WHERE id = ?", delivery.id);
      throw error;
    }
  }

  private async fill(delivery: DeliveryRow, signal: SignalRow, input: { agentAddress: string; sizeAda: number; forceOutcome?: "win" | "loss" }) {
    const forced = input.forceOutcome ?? (this.config.dexOutcome === "auto" ? undefined : this.config.dexOutcome);
    const draw = (seed: string) => parseInt(sha256Hex(seed).slice(0, 8), 16) / 0x1_0000_0000;
    const win = forced ? forced === "win" : draw(`${delivery.id}:outcome`) < signal.confidence;
    const move = 0.03 + 0.05 * draw(`${delivery.id}:move`);
    const entry = PRICES_ADA[signal.token] ?? 1;
    const up = (signal.direction === "long") === win;
    const exit = entry * (up ? 1 + move : 1 - move);
    const pnlAda = input.sizeAda * move * (win ? 1 : -1);
    const pnlUsdm = Math.round(pnlAda * this.config.adaPriceUsdm * 1e6) / 1e6;
    const tradeId = newId("trd");
    let payout;
    if (pnlUsdm > 0) {
      payout = await this.chain.transfer("marketMaker", input.agentAddress, this.config.usdmAsset, toUnits(pnlUsdm.toFixed(6)),
        { msg: ["CARSEM DEX simulator payout", tradeId] });
    }
    this.db.run(`INSERT INTO trades (id, delivery_id, agent_address, signal_id, pair, direction, size_ada, entry_price, exit_price, pnl_units, outcome, payout_tx, simulated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      tradeId, delivery.id, input.agentAddress, signal.id, signal.pair, signal.direction, input.sizeAda, entry, exit,
      (pnlUsdm < 0 ? `-${toUnits((-pnlUsdm).toFixed(6))}` : toUnits(pnlUsdm.toFixed(6)).toString()), win ? "win" : "loss", payout?.txHash ?? null, Date.now());
    this.signals.markOutcome(signal.id, win ? "hit" : "miss");
    return {
      id: tradeId,
      simulated: true,
      venue: "Minswap preprod (simulated fill)",
      pair: signal.pair,
      side: signal.direction === "long" ? `buy ${signal.token}` : `sell ${signal.token}`,
      sizeAda: input.sizeAda,
      entryPriceAda: entry,
      exitPriceAda: Number(exit.toPrecision(6)),
      outcome: win ? "win" : "loss",
      pnlAda: Number(pnlAda.toFixed(6)),
      pnlUsdm: Number(pnlUsdm.toFixed(6)),
      payout: payout ? { amount: fromUnits(toUnits(pnlUsdm.toFixed(6))), tx: payout } : null,
    };
  }

  trades(agentAddress?: string) {
    return this.db.all<Record<string, unknown>>(`SELECT * FROM trades ${agentAddress ? "WHERE agent_address = ?" : ""} ORDER BY created_at DESC LIMIT 100`, ...(agentAddress ? [agentAddress] : []))
      .map(t => ({ ...t, pnl: fromUnits(String(t.pnl_units)), simulated: t.simulated === 1, created_at: new Date(Number(t.created_at)).toISOString() }));
  }
}

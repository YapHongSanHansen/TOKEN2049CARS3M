import type { Express } from "express";
import { LOVELACE, NETWORK, fromUnits, toUnits } from "@carsem/shared";
import type { SimulatedChain } from "../chain/simulated.js";
import type { Context } from "../context.js";
import { HttpError } from "../services/errors.js";
import { wrap } from "./wrap.js";

export function miscRoutes(app: Express, ctx: Context) {
  const { config, chain, db, dex } = ctx;

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: chain.mode,
      network: NETWORK,
      facilitator: chain.mode === "preprod" ? config.preprod.facilitatorUrl : "built-in (simulated ledger)",
      treasury: chain.treasuryAddress,
      usdmAsset: config.usdmAsset,
      signalPrice: fromUnits(config.signalPrice),
      l1Confirmations: config.l1Confirmations,
    });
  });

  app.get("/chain/balances/:address", wrap(async (req, res) => {
    const balances = await chain.balances(req.params.address);
    res.json({ address: req.params.address, explorerUrl: chain.explorerAddress(req.params.address), tADA: fromUnits(balances[LOVELACE] ?? "0"), tUSDM: fromUnits(balances[config.usdmAsset] ?? "0"), raw: balances });
  }));

  // DEX simulator (Minswap stand-in).
  app.post("/dex/swap", wrap(async (req, res) => {
    const force = req.body?.forceOutcome;
    if (force !== undefined && force !== "win" && force !== "loss") throw new HttpError(400, "forceOutcome must be win or loss");
    res.json(await dex.swap({ agentAddress: String(req.body?.agentAddress ?? ""), deliveryId: String(req.body?.deliveryId ?? ""), sizeAda: Number(req.body?.sizeAda), forceOutcome: force }));
  }));
  app.get("/dex/trades", (req, res) => { res.json(dex.trades(typeof req.query.agentAddress === "string" ? req.query.agentAddress : undefined)); });

  // One feed for the dashboard / agent activity view.
  app.get("/activity", (_req, res) => {
    const rows = [
      ...db.all<{ at: number; loan_id: string; kind: string; amount_units: string | null; tx: string | null }>("SELECT created_at AS at, loan_id, kind, amount_units, tx FROM loan_events ORDER BY id DESC LIMIT 50")
        .map(e => ({ at: e.at, type: `loan.${e.kind}`, loanId: e.loan_id, amount: e.amount_units && fromUnits(e.amount_units), tx: e.tx })),
      ...db.all<{ at: number; id: string; signal_id: string; buyer: string | null; payment_tx: string; delivery_hash: string; log_tx: string | null }>("SELECT created_at AS at, id, signal_id, buyer, payment_tx, delivery_hash, log_tx FROM deliveries ORDER BY created_at DESC LIMIT 50")
        .map(d => ({ at: d.at, type: "signal.delivered", deliveryId: d.id, signalId: d.signal_id, buyer: d.buyer, tx: d.payment_tx, deliveryHash: d.delivery_hash, logTx: d.log_tx })),
      ...db.all<{ at: number; id: string; outcome: string; pnl_units: string; payout_tx: string | null }>("SELECT created_at AS at, id, outcome, pnl_units, payout_tx FROM trades ORDER BY created_at DESC LIMIT 50")
        .map(t => ({ at: t.at, type: "dex.trade", tradeId: t.id, outcome: t.outcome, pnl: fromUnits(t.pnl_units), tx: t.payout_tx, simulated: true })),
      ...db.all<{ at: number; id: string; bundle_id: string; bid_id: string; price_units: string; payment_tx: string }>("SELECT created_at AS at, id, bundle_id, bid_id, price_units, payment_tx FROM sales ORDER BY created_at DESC LIMIT 50")
        .map(s => ({ at: s.at, type: "market.sale", saleId: s.id, bundleId: s.bundle_id, bidId: s.bid_id, price: fromUnits(s.price_units), tx: s.payment_tx })),
    ].sort((a, b) => b.at - a.at).slice(0, 100)
      .map(({ at, tx, ...rest }) => ({ at: new Date(at).toISOString(), ...rest, tx: tx && { hash: tx, explorerUrl: chain.explorerTx(tx) } }));
    res.json(rows);
  });

  if (chain.mode === "simulated") {
    const { ledger } = chain as SimulatedChain;
    app.get("/sim/balances/:address", (req, res) => {
      const balances = ledger.balances(req.params.address);
      res.json({ address: req.params.address, simulated: true, tADA: fromUnits(balances[LOVELACE] ?? "0"), tUSDM: fromUnits(balances[config.usdmAsset] ?? "0"), raw: balances });
    });
    app.get("/sim/txs/:hash", (req, res) => {
      const tx = ledger.getTx(req.params.hash);
      if (!tx) throw new HttpError(404, `No simulated transaction ${req.params.hash}`);
      res.json({ simulated: true, ...tx });
    });
    app.get("/sim/txs", (_req, res) => {
      res.json(db.all("SELECT hash, kind, from_address, to_address, asset, amount, created_at FROM sim_txs ORDER BY created_at DESC LIMIT 100"));
    });
    // Test faucet: { address, ada?, usdm? }
    app.post("/sim/faucet", (req, res) => {
      const address = String(req.body?.address ?? "");
      if (!/^addr_test1[0-9a-z]+$/.test(address)) throw new HttpError(400, "address must be a preprod-style address");
      const minted: string[] = [];
      if (req.body?.ada) minted.push(ledger.mint(address, LOVELACE, toUnits(String(req.body.ada))));
      if (req.body?.usdm) minted.push(ledger.mint(address, config.usdmAsset, toUnits(String(req.body.usdm))));
      const balances = ledger.balances(address);
      res.json({ address, minted, tADA: fromUnits(balances[LOVELACE] ?? "0"), tUSDM: fromUnits(balances[config.usdmAsset] ?? "0") });
    });
    // Demo reset helper: set an exact tUSDM balance (e.g. 0.05 for "not enough money").
    app.post("/sim/set-usdm", (req, res) => {
      const address = String(req.body?.address ?? "");
      const target = toUnits(String(req.body?.usdm ?? ""));
      const current = ledger.balance(address, config.usdmAsset);
      if (target > current) ledger.mint(address, config.usdmAsset, target - current);
      else if (target < current) {
        db.run("UPDATE sim_balances SET amount = ? WHERE address = ? AND asset = ?", target.toString(), address, config.usdmAsset);
      }
      res.json({ address, tUSDM: fromUnits(ledger.balance(address, config.usdmAsset)) });
    });
  }
}

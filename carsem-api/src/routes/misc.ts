import type { Express } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOVELACE, NETWORK, fromUnits, repoRoot, toUnits } from "@carsem/shared";
import type { SimulatedChain } from "../chain/simulated.js";
import { userOf, type Context } from "../context.js";
import { HttpError } from "../services/errors.js";
import { wrap } from "./wrap.js";

/** The `carsem` CLI, served by the platform itself: `curl -fsSL <api>/install.sh | sh`. */
function installScript(config: Context["config"]) {
  const q = (v: string) => JSON.stringify(v);
  return [
    "#!/bin/sh",
    "# CARSEM CLI installer. Puts the carsem command in ~/.carsem/bin (Node.js 20+ is required).",
    "set -e",
    `API="${config.publicUrl}"`,
    'DIR="$HOME/.carsem/bin"',
    'command -v node >/dev/null 2>&1 || { echo "carsem needs Node.js 20 or newer: https://nodejs.org" >&2; exit 1; }',
    'mkdir -p "$DIR"',
    'curl -fsSL "$API/cli/carsem.cjs" -o "$DIR/carsem.cjs"',
    `printf '#!/bin/sh\nexec node "%s/carsem.cjs" "$@"\n' "$DIR" > "$DIR/carsem"`,
    `printf '@echo off\r\nnode "%%~dp0carsem.cjs" %%*\r\n' > "$DIR/carsem.cmd"`,
    'chmod +x "$DIR/carsem" "$DIR/carsem.cjs"',
    `printf '%s\n' ${q(JSON.stringify({ api: config.publicUrl, gateway: config.gatewayPublicUrl, web: config.frontendUrl }))} > "$HOME/.carsem/config.json"`,
    'case ":$PATH:" in *":$DIR:"*) ;; *) echo "Add it to your PATH:  export PATH=\\"$DIR:\\$PATH\\"";; esac',
    'echo "Installed: $DIR/carsem"',
    'echo "Next:      carsem link      (connect your wallet)"',
    'echo "           carsem codex     (plug CARSEM into Codex)"',
    "",
  ].join("\n");
}

export function miscRoutes(app: Express, ctx: Context) {
  const { config, chain, db, dex } = ctx;
  app.get("/install.sh", (_req, res) => { res.type("text/x-shellscript").send(installScript(config)); });
  app.get("/cli/carsem.cjs", (_req, res) => {
    const bundle = join(repoRoot(), "cli", "dist", "carsem.cjs");
    if (!existsSync(bundle)) throw new HttpError(503, "The CLI is not built on this server: run npm run build:cli");
    res.type("application/javascript").send(readFileSync(bundle, "utf8"));
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: chain.mode,
      network: NETWORK,
      facilitator: chain.mode === "preprod" ? config.preprod.facilitatorUrl : "built-in (simulated ledger)",
      treasury: chain.treasuryAddress,
      usdmAsset: config.usdmAsset,
      prices: Object.fromEntries(Object.entries(config.prices).map(([k, v]) => [k, fromUnits(v)])),
      publicAccessPrice: fromUnits(config.publicAccessPrice),
      kyc: "mock (demo)",
      issuer: ctx.issuer.did,
      gateway: config.gatewayPublicUrl,
      l1Confirmations: config.l1Confirmations,
    });
  });

  app.get("/chain/balances/:address", wrap(async (req, res) => {
    const balances = await chain.balances(req.params.address);
    res.json({ address: req.params.address, explorerUrl: chain.explorerAddress(req.params.address), tADA: fromUnits(balances[LOVELACE] ?? "0"), tUSDM: fromUnits(balances[config.usdmAsset] ?? "0"), raw: balances });
  }));

  // DEX simulator (Minswap stand-in). The caller's own agent trades a signal it bought.
  app.post("/dex/swap", wrap(async (req, res) => {
    const agent = ctx.users.requireOnboarded(userOf(ctx, req));
    const force = req.body?.forceOutcome;
    if (force !== undefined && force !== "win" && force !== "loss") throw new HttpError(400, "forceOutcome must be win or loss");
    res.json(await dex.swap({ agentAddress: agent.address, deliveryId: String(req.body?.deliveryId ?? ""), sizeAda: Number(req.body?.sizeAda), forceOutcome: force }));
  }));
  app.get("/dex/trades", (req, res) => { res.json(dex.trades(typeof req.query.agentAddress === "string" ? req.query.agentAddress : undefined)); });

  // One feed for the dashboard / agent activity view.
  app.get("/activity", (_req, res) => {
    const rows = [
      ...db.all<{ at: number; loan_id: string; kind: string; amount_units: string | null; tx: string | null }>("SELECT created_at AS at, loan_id, kind, amount_units, tx FROM loan_events ORDER BY id DESC LIMIT 50")
        .map(e => ({ at: e.at, type: `loan.${e.kind}`, loanId: e.loan_id, amount: e.amount_units && fromUnits(e.amount_units), tx: e.tx })),
      ...db.all<{ at: number; id: string; listing_id: string; category: string; title: string; buyer_address: string | null; payment_tx: string; delivery_hash: string; log_tx: string | null }>("SELECT d.created_at AS at, d.id, d.listing_id, l.category, l.title, d.buyer_address, d.payment_tx, d.delivery_hash, d.log_tx FROM deliveries d JOIN listings l ON l.id = d.listing_id ORDER BY d.created_at DESC LIMIT 50")
        .map(d => ({ at: d.at, type: "data.delivered", deliveryId: d.id, listingId: d.listing_id, category: d.category, title: d.title, buyer: d.buyer_address, tx: d.payment_tx, deliveryHash: d.delivery_hash, logTx: d.log_tx })),
      ...db.all<{ at: number; id: string; outcome: string; pnl_units: string; payout_tx: string | null }>("SELECT created_at AS at, id, outcome, pnl_units, payout_tx FROM trades ORDER BY created_at DESC LIMIT 50")
        .map(t => ({ at: t.at, type: "dex.trade", tradeId: t.id, outcome: t.outcome, pnl: fromUnits(t.pnl_units), tx: t.payout_tx, simulated: true })),
      ...db.all<{ at: number; id: string; bundle_id: string; channel: string; bid_id: string | null; price_units: string; payment_tx: string }>("SELECT created_at AS at, id, bundle_id, channel, bid_id, price_units, payment_tx FROM sales ORDER BY created_at DESC LIMIT 50")
        .map(s => ({ at: s.at, type: `market.${s.channel}_sale`, saleId: s.id, bundleId: s.bundle_id, bidId: s.bid_id, price: fromUnits(s.price_units), tx: s.payment_tx })),
      ...db.all<{ at: number; id: string; name: string }>("SELECT onboarded_at AS at, id, name FROM users WHERE onboarded_at IS NOT NULL ORDER BY onboarded_at DESC LIMIT 20")
        .map(u => ({ at: u.at, type: "user.onboarded", userId: u.id, name: u.name, tx: null })),
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

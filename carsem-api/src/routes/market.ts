import type { Express, Request } from "express";
import { fromUnits } from "@carsem/shared";
import { userOf, type Context } from "../context.js";
import { HttpError } from "../services/errors.js";

const bidOf = (value: unknown) => {
  if (typeof value !== "string" || !value) throw new HttpError(400, "bid query parameter is required (a bid id or enterprise name)");
  return value;
};
const optionalUser = (ctx: Context, req: Request) => (req.get("Authorization") ? userOf(ctx, req) : undefined);

export function marketGuards(app: Express, ctx: Context) {
  app.post("/market/bundles/:id/buy", (req, _res, next) => {
    ctx.market.assertEnterpriseBuyable(req.params.id, bidOf(req.query.bid));
    next();
  });
  app.post("/market/bundles/:id/access", (req, _res, next) => {
    ctx.market.assertPublicAccess(req.params.id, userOf(ctx, req));
    next();
  });
}

export function marketRoutes(app: Express, ctx: Context) {
  const { market, paywall, chain, sync, config, db } = ctx;

  app.get("/market/bids", (_req, res) => { res.json(market.bids()); });
  app.get("/market/bundles", (req, res) => { res.json(market.listings(optionalUser(ctx, req))); });
  app.get("/market/sales", (_req, res) => { res.json(market.sales()); });

  // Paid, private channel: an enterprise buys a pledged (or published) bundle at its bid.
  app.post("/market/bundles/:id/buy", (req, res) => {
    const bundleId = req.params.id;
    const bid = market.bid(bidOf(req.query.bid));
    const body = paywall.respond(req, ({ txHash, payer }) => ({
      body: { channel: "enterprise", enterprise: bid.enterprise, price: fromUnits(market.bidPrice(bid)), payment: { tx: txHash, explorerUrl: chain.explorerTx(txHash) }, bundle: sync.contents(bundleId) },
      effect: () => market.recordEnterpriseSale(bundleId, bid.id, payer, txHash),
    }));
    res.json(body);
  });

  // Paid, public channel: after a default, any CARSEM user can access the published chats for a fee.
  app.post("/market/bundles/:id/access", (req, res) => {
    const bundleId = req.params.id;
    const user = userOf(ctx, req);
    const body = paywall.respond(req, ({ txHash, payer }) => ({
      body: { channel: "public", price: fromUnits(config.publicAccessPrice), payment: { tx: txHash, explorerUrl: chain.explorerTx(txHash) }, bundle: sync.contents(bundleId) },
      effect: () => market.recordPublicSale(bundleId, user.id, payer, txHash),
    }));
    res.json(body);
  });

  // Re-read a bundle you bought.
  app.get("/market/bundles/:id/content", (req, res) => {
    const user = userOf(ctx, req);
    if (!db.get("SELECT 1 FROM sales WHERE bundle_id = ? AND buyer_user_id = ?", req.params.id, user.id)) throw new HttpError(403, "You have not bought this bundle");
    res.json(sync.contents(req.params.id));
  });
}

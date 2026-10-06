import type { Express } from "express";
import { fromUnits } from "@carsem/shared";
import type { Context } from "../context.js";
import { HttpError } from "../services/errors.js";

const bidOf = (value: unknown) => {
  if (typeof value !== "string" || !value) throw new HttpError(400, "bid query parameter is required (a bid id or enterprise name)");
  return value;
};

export function marketGuards(app: Express, { market }: Context) {
  app.post("/market/bundles/:id/buy", (req, _res, next) => {
    market.assertBuyable(req.params.id, bidOf(req.query.bid));
    next();
  });
}

export function marketRoutes(app: Express, { market, paywall, chain }: Context) {
  app.get("/market/bids", (_req, res) => { res.json(market.bids()); });
  app.get("/market/bundles", (_req, res) => { res.json(market.listings()); });
  app.get("/market/sales", (_req, res) => { res.json(market.sales()); });

  // Paid: the enterprise's bid price. Proceeds repay the loan behind the bundle.
  app.post("/market/bundles/:id/buy", (req, res) => {
    const bundleId = req.params.id;
    const bid = market.bid(bidOf(req.query.bid));
    const body = paywall.respond(req, ({ txHash, payer }) => ({
      body: {
        enterprise: bid.enterprise,
        price: fromUnits(market.price(bid)),
        payment: { tx: txHash, explorerUrl: chain.explorerTx(txHash) },
        bundle: market.deliverable(bundleId),
      },
      effect: () => market.recordSale(bundleId, bid.id, payer, txHash),
    }));
    res.json(body);
  });
}

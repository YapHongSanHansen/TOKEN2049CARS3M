import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createChain } from "./chain/index.js";
import type { Config } from "./config.js";
import type { Context } from "./context.js";
import { Db } from "./db.js";
import { lendingGuards, lendingRoutes } from "./routes/lending.js";
import { marketGuards, marketRoutes } from "./routes/market.js";
import { masumiRoutes } from "./routes/masumi.js";
import { miscRoutes } from "./routes/misc.js";
import { dataGuards, dataRoutes } from "./routes/data.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { DataPlatform } from "./services/data.js";
import { DexSimulator } from "./services/dex.js";
import { HttpError } from "./services/errors.js";
import { Lending } from "./services/lending.js";
import { Market } from "./services/market.js";
import { GatewayClient } from "./services/gateway.js";
import { Issuer } from "./services/identity.js";
import { Sync } from "./services/sync.js";
import { Users } from "./services/users.js";
import { createPaywall } from "./x402.js";

/** Builds the API without listening, so tests and scripts can drive it. */
export async function createApp(config: Config, options: { db?: Db } = {}) {
  const db = options.db ?? new Db(config.dbPath);
  const chain = await createChain(config, db);
  const issuer = new Issuer(config);
  const users = new Users(db, config, issuer, chain, new GatewayClient(config));
  const sync = new Sync(db, config, users);
  const data = new DataPlatform(db, config, chain);
  const lending = new Lending(db, config, chain, users, sync);
  const market = new Market(db, config, users, sync, lending);
  const dex = new DexSimulator(db, config, chain, data);
  const paywall = await createPaywall(config, chain, [
    { route: "GET /data/listings/:id", description: "Platform data: a trading signal or a live flight / hotel / product price", price: url => BigInt(data.listing(url.pathname.split("/")[3]).price_units) },
    { route: "POST /loans/:id/repay", description: "Repay a CARSEM loan: the outstanding balance", price: url => lending.outstanding(lending.get(url.pathname.split("/")[2])) },
    { route: "POST /market/bundles/:id/buy", description: "Private enterprise purchase of a redacted chat bundle at the bid price", price: url => market.bidPrice(market.bid(url.searchParams.get("bid") ?? "")) },
    { route: "POST /market/bundles/:id/access", description: "Access to a published (defaulted) redacted chat bundle", price: () => config.publicAccessPrice },
  ]);
  const ctx: Context = { config, db, chain, paywall, issuer, users, sync, data, lending, market, dex };

  const app = express();
  // The payment gate and the routes must recognise exactly the same URLs.
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.use(cors({ origin: true, allowedHeaders: ["Content-Type", "Authorization", "PAYMENT-SIGNATURE"], exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
  app.use(express.json({ limit: "256kb" }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  // Validate paid requests first, so nobody pays for a 404 or a closed loan.
  dataGuards(app, ctx);
  lendingGuards(app, ctx);
  marketGuards(app, ctx);
  app.use(paywall.middleware);

  miscRoutes(app, ctx);
  onboardingRoutes(app, ctx);
  dataRoutes(app, ctx);
  lendingRoutes(app, ctx);
  marketRoutes(app, ctx);
  masumiRoutes(app, ctx);

  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) }); return; }
    if (error instanceof SyntaxError && "status" in error) { res.status(400).json({ error: "Malformed JSON body" }); return; }
    console.error("[carsem-api]", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  });

  return { app, ctx, close: () => db.close() };
}

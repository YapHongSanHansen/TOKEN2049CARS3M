import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { fromUnits } from "@carsem/shared";
import { createChain } from "./chain/index.js";
import type { Config } from "./config.js";
import type { Context } from "./context.js";
import { Db } from "./db.js";
import { lendingGuards, lendingRoutes } from "./routes/lending.js";
import { marketGuards, marketRoutes } from "./routes/market.js";
import { masumiRoutes } from "./routes/masumi.js";
import { miscRoutes } from "./routes/misc.js";
import { signalGuards, signalRoutes } from "./routes/signals.js";
import { userRoutes } from "./routes/users.js";
import { DexSimulator } from "./services/dex.js";
import { HttpError } from "./services/errors.js";
import { Lending } from "./services/lending.js";
import { Market } from "./services/market.js";
import { Signals } from "./services/signals.js";
import { Users } from "./services/users.js";
import { createPaywall } from "./x402.js";

/** Builds the API without listening, so tests and scripts can drive it. */
export async function createApp(config: Config, options: { db?: Db } = {}) {
  const db = options.db ?? new Db(config.dbPath);
  const chain = await createChain(config, db);
  const users = new Users(db, config);
  const lending = new Lending(db, config, chain, users);
  const signals = new Signals(db, chain);
  const market = new Market(db, config, users, lending);
  const dex = new DexSimulator(db, config, chain, signals);
  const paywall = await createPaywall(config, chain, [
    { route: "GET /signals/latest", description: `Latest trading signal for a token (${fromUnits(config.signalPrice)} tUSDM)`, price: () => config.signalPrice },
    { route: "POST /loans/:id/repay", description: "Repay a CARSEM loan: the outstanding balance", price: url => lending.outstanding(lending.get(url.pathname.split("/")[2])) },
    { route: "POST /market/bundles/:id/buy", description: "A redacted chat bundle at the enterprise's bid price", price: url => market.price(market.bid(url.searchParams.get("bid") ?? "")) },
  ]);
  const ctx: Context = { config, db, chain, paywall, users, lending, signals, market, dex };

  const app = express();
  // The payment gate and the routes must recognise exactly the same URLs.
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.use(cors({ origin: true, allowedHeaders: ["Content-Type", "Authorization", "PAYMENT-SIGNATURE"], exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
  app.use(express.json({ limit: "256kb" }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  // Validate paid requests first, so nobody pays for a 404 or a closed loan.
  signalGuards(app, ctx);
  lendingGuards(app, ctx);
  marketGuards(app, ctx);
  app.use(paywall.middleware);

  miscRoutes(app, ctx);
  signalRoutes(app, ctx);
  lendingRoutes(app, ctx);
  userRoutes(app, ctx);
  marketRoutes(app, ctx);
  masumiRoutes(app, ctx);

  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError && "status" in error) { res.status(400).json({ error: "Malformed JSON body" }); return; }
    console.error("[carsem-api]", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
  });

  return { app, ctx, close: () => db.close() };
}

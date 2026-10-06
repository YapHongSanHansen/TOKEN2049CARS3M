import type { Request } from "express";
import type { Chain } from "./chain/index.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { DataPlatform } from "./services/data.js";
import type { DexSimulator } from "./services/dex.js";
import type { Issuer } from "./services/identity.js";
import type { Lending } from "./services/lending.js";
import type { Market } from "./services/market.js";
import type { Sync } from "./services/sync.js";
import type { UserRow, Users } from "./services/users.js";
import type { Paywall } from "./x402.js";

export interface Context {
  config: Config;
  db: Db;
  chain: Chain;
  paywall: Paywall;
  issuer: Issuer;
  users: Users;
  sync: Sync;
  data: DataPlatform;
  lending: Lending;
  market: Market;
  dex: DexSimulator;
}

/** The caller, from `Authorization: Bearer csm_…`. */
export const userOf = (ctx: Context, req: Request): UserRow => ctx.users.authenticate(req.get("Authorization"));

import type { Chain } from "./chain/index.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { DexSimulator } from "./services/dex.js";
import type { Lending } from "./services/lending.js";
import type { Market } from "./services/market.js";
import type { Signals } from "./services/signals.js";
import type { Users } from "./services/users.js";
import type { Paywall } from "./x402.js";

export interface Context {
  config: Config;
  db: Db;
  chain: Chain;
  paywall: Paywall;
  users: Users;
  lending: Lending;
  signals: Signals;
  market: Market;
  dex: DexSimulator;
}

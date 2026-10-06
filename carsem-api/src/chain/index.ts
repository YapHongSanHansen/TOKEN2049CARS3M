import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { createPreprodChain } from "./preprod.js";
import { createSimulatedChain } from "./simulated.js";
import type { Chain } from "./types.js";

export type { Chain, ChainTx, WalletRole } from "./types.js";

export async function createChain(config: Config, db: Db): Promise<Chain> {
  return config.mode === "preprod" ? createPreprodChain(config) : createSimulatedChain(config, db);
}

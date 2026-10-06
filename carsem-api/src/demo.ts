/**
 * Demo data: uploaders + ~50 signals, enterprise bids, the demo user with an
 * opted-in redacted bundle, and the demo agent. In simulated mode it also funds
 * the agent with 100 tADA and exactly 0.05 tUSDM ("not enough money") and the
 * enterprise buyer wallets.
 */
import { LOVELACE, SimWallet, sha256Hex, toUnits } from "@carsem/shared";
import { toClientCardanoSigner } from "@x402/cardano";
import { createSimulatedChain } from "./chain/simulated.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { Users } from "./services/users.js";

export const DEMO_USER = "usr_demo";
export const ENTERPRISES = ["eBay", "Amazon", "BNB", "Meta"];
export const DEMO_CHATS = [
  "My girlfriend's birthday on 30th Sept, looking for a necklace under $200",
  "Book a flight to Singapore for TOKEN2049 and a hotel near Marina Bay",
  "Remind me to pay rent to my landlord John on the 1st",
  "Call Sarah at +60 12-345 6789 about the job interview on Friday",
  "Thinking of buying a new iPhone if the price drops below 3000 RM",
  "My doctor said I should keep taking the medication",
  "Send 50 ADA to addr_test1qp7573my7h0fyj9cd2fwrws5v6ep0e6urpx007pz0pjnmakny46m3vmfawqwv3m48dv2s6eysht6tjfdk48lrzrkmj5qpmyq7l",
  "Dinner reservation for two at 8pm, somewhere near 12 Jalan Ampang",
];

const UPLOADERS = [
  ["upl_whale", "WhaleWatcher"], ["upl_quant", "QuantKitten"], ["upl_onchain", "OnChainOracle"],
  ["upl_degen", "DegenDan"], ["upl_minmax", "MinMaxer"],
] as const;
const TOKENS = ["MIN", "SNEK", "INDY", "DJED", "HOSKY"];
const RATIONALES = {
  long: ["DEX volume up 3 days running with rising buy-side depth", "Whale wallets accumulating; exchange outflows rising", "Breakout above the 7-day range on above-average volume", "Liquidity added to the main pool; funding positive"],
  short: ["Large unlock next week; sell walls stacking", "Volume fading into resistance; momentum divergence", "Whale wallets distributing to exchanges", "Pool liquidity pulled overnight"],
};

export function seedDemo(db: Db, config: Config, options: { agentId: string; log?: (line: string) => void }) {
  const log = options.log ?? (() => {});
  const users = new Users(db, config);

  for (const [id, name] of UPLOADERS) db.run("INSERT INTO uploaders (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING", id, name);
  if (!db.get("SELECT 1 FROM signals LIMIT 1")) {
    const now = Date.now();
    for (const token of TOKENS) {
      for (let i = 0; i < 10; i++) {
        const pick = (salt: string) => parseInt(sha256Hex(`${token}:${i}:${salt}`).slice(0, 8), 16) / 0x1_0000_0000;
        const direction = pick("dir") < 0.62 ? "long" : "short";
        const list = RATIONALES[direction];
        db.run(`INSERT INTO signals (id, uploader_id, token, pair, direction, confidence, horizon_minutes, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          `sig_${token.toLowerCase()}_${String(i).padStart(2, "0")}`, UPLOADERS[Math.floor(pick("up") * UPLOADERS.length)][0], token, `${token}/ADA`,
          direction, Number((0.55 + 0.4 * pick("conf")).toFixed(2)), [15, 30, 60, 240][Math.floor(pick("h") * 4)],
          list[Math.floor(pick("r") * list.length)], now - (10 - i) * 37 * 60_000);
      }
    }
    // The demo's MIN signal: a confident long.
    db.run("UPDATE signals SET direction = 'long', confidence = 0.82, rationale = ? WHERE id = 'sig_min_09'", RATIONALES.long[0]);
    log(`signals     ${TOKENS.length * 10} across ${TOKENS.join(", ")}`);
  }

  // Enterprise bids, price per bundle in tUSDM.
  for (const [enterprise, price, records] of [["eBay", 50, 1000], ["Amazon", 25, 500], ["BNB", 10, 200], ["Meta", 5, 100]] as const) {
    db.run("INSERT INTO bids (id, enterprise, price_usdm, data_amount) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", `bid_${enterprise.toLowerCase()}`, enterprise, price, records);
  }

  users.create("Alice (demo)", DEMO_USER);
  let agentAddress: string | undefined;
  if (config.mode === "simulated") agentAddress = new SimWallet(config.sim.agentSeed).address;
  else if (config.preprod.agentMnemonic) {
    agentAddress = toClientCardanoSigner({ mnemonic: config.preprod.agentMnemonic, network: "cardano:preprod", provider: { blockfrost: config.preprod.blockfrost } }).getAddress();
  }
  if (!agentAddress) {
    log("agent       skipped: set AGENT_MNEMONIC to register the demo agent on preprod");
    return { agentAddress };
  }
  if (db.get("SELECT 1 FROM agents WHERE id = ?", options.agentId)) db.run("UPDATE agents SET address = ? WHERE id = ?", agentAddress, options.agentId);
  else users.registerAgent(DEMO_USER, { id: options.agentId, name: "Alice's trading agent", address: agentAddress, apiKey: config.demoAgentKey });
  log(`agent       ${options.agentId} ${agentAddress}`);

  if (!db.get("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('disbursing','open')", DEMO_USER)) {
    const consent = users.grantConsent(DEMO_USER, { chats: DEMO_CHATS, agentId: options.agentId });
    log(`consent     ${DEMO_USER} -> bundle ${consent.bundle?.id} (collateral_ref ${consent.bundle?.collateralRef.slice(0, 16)}…)`);
  }

  if (config.mode === "simulated") {
    const { ledger, treasuryAddress } = createSimulatedChain(config, db);
    const topUp = (address: string, asset: string, target: bigint) => {
      const current = ledger.balance(address, asset);
      if (current < target) ledger.mint(address, asset, target - current);
    };
    topUp(agentAddress, LOVELACE, toUnits("100"));
    db.run("INSERT INTO sim_balances (address, asset, amount) VALUES (?, ?, ?) ON CONFLICT (address, asset) DO UPDATE SET amount = excluded.amount",
      agentAddress, config.usdmAsset, toUnits("0.05").toString());
    for (const enterprise of ENTERPRISES) {
      const wallet = new SimWallet(`enterprise-${enterprise.toLowerCase()}`);
      topUp(wallet.address, LOVELACE, toUnits("20"));
      topUp(wallet.address, config.usdmAsset, toUnits("100"));
    }
    log(`wallets     agent 100 tADA + 0.05 tUSDM; treasury ${treasuryAddress}; enterprises 100 tUSDM each`);
  }
  return { agentAddress };
}

/**
 * Demo data for the platform: uploaders, ~60 listings (trading signals and
 * flight / hotel / product prices matching the example prompts), enterprise
 * bids, and (simulated mode) funded enterprise buyer wallets. Users are not
 * seeded: they onboard through the gate (npm run demo:user does it for you).
 */
import { LOVELACE, SimWallet, sha256Hex, toUnits } from "@carsem/shared";
import { createSimulatedChain } from "./chain/simulated.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { subjectOf } from "./services/data.js";

export const ENTERPRISES = ["eBay", "Amazon", "BNB", "Meta"];

const UPLOADERS = [
  ["upl_whale", "WhaleWatcher"], ["upl_quant", "QuantKitten"], ["upl_onchain", "OnChainOracle"], ["upl_degen", "DegenDan"],
  ["upl_minmax", "MinMaxer"], ["upl_flyer", "KLFlyer"], ["upl_stay", "SGStayHunter"], ["upl_deals", "DealScout"],
] as const;
const TOKENS = ["MIN", "SNEK", "INDY", "DJED", "HOSKY"];
const RATIONALES = {
  long: ["DEX volume up 3 days running with rising buy-side depth", "Whale wallets accumulating; exchange outflows rising", "Breakout above the 7-day range on above-average volume", "Liquidity added to the main pool; funding positive"],
  short: ["Large unlock next week; sell walls stacking", "Volume fading into resistance; momentum divergence", "Whale wallets distributing to exchanges", "Pool liquidity pulled overnight"],
};

const FLIGHTS = [
  { from: "KUL", to: "SIN", airline: "AirAsia", flight: "AK713", date: "2026-10-10", price: 129, currency: "MYR" },
  { from: "KUL", to: "SIN", airline: "Scoot", flight: "TR451", date: "2026-10-10", price: 142, currency: "MYR" },
  { from: "KUL", to: "SIN", airline: "Malaysia Airlines", flight: "MH603", date: "2026-10-10", price: 268, currency: "MYR" },
  { from: "KUL", to: "SIN", airline: "Batik Air", flight: "OD801", date: "2026-10-11", price: 118, currency: "MYR" },
  { from: "SIN", to: "KUL", airline: "AirAsia", flight: "AK714", date: "2026-10-13", price: 135, currency: "MYR" },
];
const HOTELS = [
  { city: "Singapore", area: "Geylang", name: "Hotel 81 Rochor", pricePerNight: 98, currency: "SGD", rating: 3.6 },
  { city: "Singapore", area: "Geylang", name: "Fragrance Hotel - Crystal", pricePerNight: 89, currency: "SGD", rating: 3.4 },
  { city: "Singapore", area: "Geylang", name: "Value Hotel Thomson Geylang", pricePerNight: 104, currency: "SGD", rating: 3.8 },
  { city: "Singapore", area: "Marina Bay", name: "Pan Pacific Singapore", pricePerNight: 420, currency: "SGD", rating: 4.6 },
];
const PRODUCTS = [
  { name: "Pokemon 30th Anniversary Booster Pack", store: "Shopee MY", price: 39, currency: "MYR" },
  { name: "Pokemon 30th Anniversary Booster Pack", store: "Lazada MY", price: 45, currency: "MYR" },
  { name: "Pokemon 30th Anniversary Elite Trainer Box", store: "Toys R Us MY", price: 289, currency: "MYR" },
  { name: "Sterling silver heart necklace (gift box)", store: "Pandora KL", price: 329, currency: "MYR", note: "popular birthday gift" },
  { name: "Gold-plated initial necklace", store: "Shopee MY", price: 79, currency: "MYR", note: "budget birthday gift" },
];

export function seedDemo(db: Db, config: Config, options: { log?: (line: string) => void } = {}) {
  const log = options.log ?? (() => {});
  for (const [id, name] of UPLOADERS) db.run("INSERT INTO uploaders (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING", id, name);

  if (!db.get("SELECT 1 FROM listings LIMIT 1")) {
    const now = Date.now();
    const insert = (id: string, category: "signal" | "flight" | "hotel" | "product", data: Record<string, unknown>, title: string, uploader: string, at: number) =>
      db.run("INSERT INTO listings (id, category, subject, title, payload_json, uploader_id, price_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id, category, subjectOf(category, data), title, JSON.stringify(data), uploader, config.prices[category].toString(), at);
    for (const token of TOKENS) {
      for (let i = 0; i < 10; i++) {
        const pick = (salt: string) => parseInt(sha256Hex(`${token}:${i}:${salt}`).slice(0, 8), 16) / 0x1_0000_0000;
        const direction = pick("dir") < 0.62 ? "long" : "short";
        const list = RATIONALES[direction];
        const data = {
          token, pair: `${token}/ADA`, direction, confidence: Number((0.55 + 0.4 * pick("conf")).toFixed(2)),
          horizonMinutes: [15, 30, 60, 240][Math.floor(pick("h") * 4)], rationale: list[Math.floor(pick("r") * list.length)],
        };
        insert(`sig_${token.toLowerCase()}_${String(i).padStart(2, "0")}`, "signal", data, `${direction.toUpperCase()} ${token}/ADA`, UPLOADERS[Math.floor(pick("up") * 5)][0], now - (10 - i) * 37 * 60_000);
      }
    }
    // The demo's MIN signal: a confident long, the most recent.
    db.run("UPDATE listings SET payload_json = ?, title = 'LONG MIN/ADA' WHERE id = 'sig_min_09'",
      JSON.stringify({ token: "MIN", pair: "MIN/ADA", direction: "long", confidence: 0.82, horizonMinutes: 60, rationale: RATIONALES.long[0] }));
    FLIGHTS.forEach((f, i) => insert(`fli_${i}`, "flight", f, `${f.from}→${f.to} ${f.airline} ${f.flight} ${f.date}: ${f.currency} ${f.price}`, "upl_flyer", now - i * 600_000));
    HOTELS.forEach((h, i) => insert(`hot_${i}`, "hotel", h, `${h.name}, ${h.area}: ${h.currency} ${h.pricePerNight}/night`, "upl_stay", now - i * 600_000));
    PRODUCTS.forEach((p, i) => insert(`pro_${i}`, "product", p, `${p.name} @ ${p.store}: ${p.currency} ${p.price}`, "upl_deals", now - i * 600_000));
    log(`listings    ${TOKENS.length * 10} signals, ${FLIGHTS.length} flights, ${HOTELS.length} hotels, ${PRODUCTS.length} products`);
  }

  for (const [enterprise, price, records] of [["eBay", 50, 1000], ["Amazon", 25, 500], ["BNB", 10, 200], ["Meta", 5, 100]] as const) {
    db.run("INSERT INTO bids (id, enterprise, price_usdm, data_amount) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", `bid_${enterprise.toLowerCase()}`, enterprise, price, records);
  }
  log("bids        eBay 50 · Amazon 25 · BNB 10 · Meta 5 USDM");

  if (config.mode === "simulated") {
    const { ledger, treasuryAddress } = createSimulatedChain(config, db);
    for (const enterprise of ENTERPRISES) {
      const wallet = new SimWallet(`enterprise-${enterprise.toLowerCase()}`);
      if (ledger.balance(wallet.address, LOVELACE) < toUnits("20")) ledger.mint(wallet.address, LOVELACE, toUnits("20"));
      if (ledger.balance(wallet.address, config.usdmAsset) < toUnits("100")) ledger.mint(wallet.address, config.usdmAsset, toUnits("100"));
    }
    log(`wallets     treasury ${treasuryAddress}; enterprise buyers funded with 100 USDM each`);
  }
}

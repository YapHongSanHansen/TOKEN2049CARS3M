/**
 * Demo data for the platform: uploaders (each with a preprod wallet address), the Market's
 * listings (5 trading signals, 5 flights, 5 hotels: 3 fresh and paid, 2 free from ~5 days ago),
 * products for the agent's shopping prompts, enterprise bids, and (simulated mode) funded
 * enterprise buyer wallets. Users are not seeded: they onboard through the gate
 * (npm run demo:user does it for you).
 */
import { AddressEras } from "@evolution-sdk/evolution";
import { LOVELACE, SimWallet, sha256Hex, toUnits } from "@carsem/shared";
import { createSimulatedChain } from "./chain/simulated.js";
import type { Category, Config } from "./config.js";
import type { Db } from "./db.js";
import { subjectOf } from "./services/data.js";

export const ENTERPRISES = ["eBay", "Amazon", "BNB", "Meta"];

// [id, name, hits, misses]: reputation = (hits + 1) / (hits + misses + 2), so the demo shows Good, Intermediate and Bad.
const UPLOADERS = [
  ["upl_whale", "WhaleWatcher", 13, 1], ["upl_flyer", "KLFlyer", 7, 4], ["upl_stay", "SGStayHunter", 3, 8], ["upl_deals", "DealScout", 5, 2],
] as const;
type UploaderId = (typeof UPLOADERS)[number][0];

/** A stable preprod base address per demo uploader (no keys behind it; it only identifies the uploader). */
export const demoUploaderAddress = (seed: string) => {
  const payment = sha256Hex(`carsem-demo-uploader:${seed}:payment`).slice(0, 56);
  const stake = sha256Hex(`carsem-demo-uploader:${seed}:stake`).slice(0, 56);
  return AddressEras.toBech32(AddressEras.fromHex(`00${payment}${stake}`));
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Fresh data costs the category's price; data from ~5 days ago is free. */
interface Seeded { id: string; uploader: UploaderId; age: number; free?: true; title: string; data: Record<string, unknown> }

// Three sellers, one per Market category. Each has MAX_ACTIVE_LISTINGS current (paid) datasets, the
// daisy's petals, and 3 older free ones from 5+ days ago, the fallen petals.
const seed = (items: Array<[id: string, age: number, title: string, data: Record<string, unknown>]>, uploader: UploaderId, current = 9): Seeded[] =>
  items.map(([id, age, title, data], i) => ({ id, uploader, age, title, data, ...(i >= current ? { free: true as const } : {}) }));

const RATIONALES = ["DEX volume up 3 days running with rising buy-side depth", "Whale wallets accumulating; exchange outflows rising", "Breakout above the 7-day range on above-average volume",
  "Liquidity added to the main pool; funding positive", "Large unlock next week; sell walls stacking", "Volume fading into resistance; momentum divergence", "Whale wallets distributing to exchanges", "Pool liquidity pulled overnight"];
const SIGNALS = seed(([
  ["MIN", "long", 0.82, 60, 12 * MINUTE], ["SNEK", "short", 0.71, 30, 48 * MINUTE], ["INDY", "long", 0.67, 240, 2 * HOUR + 15 * MINUTE],
  ["WMT", "long", 0.74, 60, 3 * HOUR + 40 * MINUTE], ["AGIX", "short", 0.63, 120, 5 * HOUR], ["NMKR", "long", 0.69, 240, 7 * HOUR + 20 * MINUTE],
  ["LQ", "short", 0.6, 60, 9 * HOUR], ["IAG", "long", 0.77, 30, 12 * HOUR + 30 * MINUTE], ["COPI", "long", 0.65, 120, 16 * HOUR],
  ["DJED", "long", 0.61, 240, 5 * DAY], ["HOSKY", "short", 0.58, 15, 5 * DAY + 3 * HOUR], ["IUSD", "short", 0.56, 60, 6 * DAY],
] as Array<[string, "long" | "short", number, number, number]>).map(([token, direction, confidence, horizonMinutes, age], i) => [
  `sig_${token.toLowerCase()}`, age, `${token}/ADA trading signal`,
  { token, pair: `${token}/ADA`, direction, confidence, horizonMinutes, rationale: RATIONALES[(i * 3) % RATIONALES.length] },
]), "upl_whale");

const FLIGHTS = seed(([
  ["AirAsia", "AK713", "KUL", "SIN", "2026-10-10", 129, 8 * MINUTE], ["Scoot", "TR451", "KUL", "SIN", "2026-10-10", 142, 35 * MINUTE],
  ["Batik Air", "OD801", "KUL", "SIN", "2026-10-11", 118, HOUR + 20 * MINUTE], ["Jetstar", "3K684", "KUL", "SIN", "2026-10-11", 136, 2 * HOUR + 50 * MINUTE],
  ["AirAsia", "AK720", "KUL", "SIN", "2026-10-12", 109, 4 * HOUR], ["Singapore Airlines", "SQ117", "KUL", "SIN", "2026-10-12", 312, 6 * HOUR + 10 * MINUTE],
  ["Scoot", "TR457", "SIN", "KUL", "2026-10-13", 131, 8 * HOUR], ["Batik Air", "OD804", "SIN", "KUL", "2026-10-13", 124, 11 * HOUR + 30 * MINUTE],
  ["AirAsia", "AK716", "SIN", "KUL", "2026-10-14", 115, 15 * HOUR],
  ["Malaysia Airlines", "MH603", "KUL", "SIN", "2026-10-10", 268, 5 * DAY], ["AirAsia", "AK714", "SIN", "KUL", "2026-10-13", 135, 5 * DAY + 4 * HOUR], ["Jetstar", "3K686", "SIN", "KUL", "2026-10-15", 128, 6 * DAY + 2 * HOUR],
] as Array<[string, string, string, string, string, number, number]>).map(([airline, flight, from, to, date, price, age]) => [
  `fli_${flight.toLowerCase()}`, age, `${from} → ${to} · ${airline} ${flight}`, { from, to, airline, flight, date, price, currency: "MYR" },
]), "upl_flyer");

const HOTELS = seed(([
  ["Hotel 81 Rochor", "Geylang", 98, 3.6, 10 * MINUTE], ["Fragrance Hotel - Crystal", "Geylang", 89, 3.4, 52 * MINUTE], ["Value Hotel Thomson Geylang", "Geylang", 104, 3.8, HOUR + 40 * MINUTE],
  ["Hotel 81 Palace", "Geylang", 92, 3.5, 3 * HOUR], ["Champion Hotel City", "Geylang", 110, 3.9, 4 * HOUR + 30 * MINUTE], ["ibis Styles Singapore on Macpherson", "Geylang", 128, 4.1, 6 * HOUR],
  ["Hotel Boss", "Lavender", 141, 4.0, 8 * HOUR + 45 * MINUTE], ["V Hotel Lavender", "Lavender", 155, 4.2, 12 * HOUR], ["Hotel G Singapore", "Bugis", 172, 4.3, 17 * HOUR],
  ["Pan Pacific Singapore", "Marina Bay", 420, 4.6, 5 * DAY], ["ibis budget Singapore Ruby", "Geylang", 95, 3.5, 5 * DAY + 2 * HOUR], ["Aqueen Hotel Paya Lebar", "Geylang", 101, 3.7, 6 * DAY + HOUR],
] as Array<[string, string, number, number, number]>).map(([name, area, pricePerNight, rating, age]) => [
  `hot_${name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18)}`, age, `${name} · ${area}`, { city: "Singapore", area, name, pricePerNight, currency: "SGD", rating },
]), "upl_stay");
/** Not on the Market page; the agent's shopping prompts (Pokémon pack, birthday gift) use them. */
const PRODUCTS: Seeded[] = [
  { name: "Pokemon 30th Anniversary Booster Pack", store: "Shopee MY", price: 39 },
  { name: "Pokemon 30th Anniversary Booster Pack", store: "Lazada MY", price: 45 },
  { name: "Pokemon 30th Anniversary Elite Trainer Box", store: "Toys R Us MY", price: 289 },
  { name: "Sterling silver heart necklace (gift box)", store: "Pandora KL", price: 329, note: "popular birthday gift" },
  { name: "Gold-plated initial necklace", store: "Shopee MY", price: 79, note: "budget birthday gift" },
].map((p, i) => ({ id: `pro_${i}`, uploader: "upl_deals" as const, age: i * 10 * MINUTE, title: `${p.name} @ ${p.store}`, data: { ...p, currency: "MYR" } }));

export const DEMO_LISTINGS: Record<Category, Seeded[]> = { signal: SIGNALS, flight: FLIGHTS, hotel: HOTELS, product: PRODUCTS };

export function seedDemo(db: Db, config: Config, options: { log?: (line: string) => void } = {}) {
  const log = options.log ?? (() => {});
  for (const [id, name, hits, misses] of UPLOADERS) {
    db.run("INSERT INTO uploaders (id, name, wallet_address, hits, misses, reputation) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      id, name, demoUploaderAddress(id), hits, misses, (hits + 1) / (hits + misses + 2));
  }

  if (!db.get("SELECT 1 FROM listings LIMIT 1")) {
    const now = Date.now();
    for (const [category, items] of Object.entries(DEMO_LISTINGS) as Array<[Category, Seeded[]]>) {
      for (const l of items) {
        db.run("INSERT INTO listings (id, category, subject, title, payload_json, uploader_id, price_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          l.id, category, subjectOf(category, l.data), l.title, JSON.stringify(l.data), l.uploader, l.free ? "0" : config.prices[category].toString(), now - l.age);
      }
    }
    log(`listings    ${SIGNALS.length} signals, ${FLIGHTS.length} flights, ${HOTELS.length} hotels (3 free in each), ${PRODUCTS.length} products`);
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

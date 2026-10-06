import type { DaisyState, PetalDataset } from "./DaisyMarket";

/** Sample data: one seller's Cardano trading datasets, 12 current and 5 archived. */
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const CURRENT: Array<[string, number, string, string, string]> = [
  ["MIN/ADA 1-hour signal", 0.3, "Direction and confidence for MIN/ADA over the next hour, from Minswap order flow.", "pair        MIN/ADA\nhorizon     60 min\ndirection   ▒▒▒▒ (unlock)\nconfidence  0.8▒", "5 USDM"],
  ["SNEK/ADA order-book depth", 3, "Bid/ask depth within 2% of mid on the three largest SNEK pools.", "pool,bid_2pct_ada,ask_2pct_ada\nminswap-v2,182400,▒▒▒▒\nsplash,96100,▒▒▒▒", "2 USDM"],
  ["DJED peg stability", 7, "Hourly DJED/USD deviation and reserve ratio, with alerts below 400%.", "hour,deviation_bps,reserve_ratio\n05:00,+3,512%\n06:00,▒▒,▒▒▒", "1 USDM"],
  ["Minswap pool flows (24h)", 11, "Net ADA in/out per pool for the top 20 Minswap pools.", "pool,net_ada_24h\nMIN/ADA,+412k\nSNEK/ADA,▒▒▒", "3 USDM"],
  ["INDY whale wallet moves", 16, "Transfers over 250k INDY between labelled wallets and exchanges.", "time,from,to,amount\n03:12,whale_07,▒▒▒▒,310000", "4 USDM"],
  ["HOSKY sentiment index", 21, "Social sentiment score (0–100) from X and Discord, hourly.", "hour,score,mentions\n04:00,61,1840\n05:00,▒▒,▒▒▒▒", "1 USDM"],
  ["ADA staking yield snapshot", 27, "Effective yield by pool size bucket, epoch to date.", "bucket,yield_pct\n<5M,2.9\n5–20M,▒▒▒", "1 USDM"],
  ["iUSD/ADA spread alert", 34, "Cross-DEX iUSD/ADA spread when it exceeds 40 bps.", "dex_a,dex_b,spread_bps\nminswap,splash,52\n▒▒▒,▒▒▒,▒▒", "2 USDM"],
  ["WMT/ADA volume breakout", 42, "Volume breakout detector on WMT/ADA with 7-day baseline.", "window,volume_x_baseline\n1h,3.4x\n4h,▒▒▒", "3 USDM"],
  ["Lending utilisation (Liqwid)", 51, "Utilisation and borrow APY per Liqwid market.", "market,utilisation,borrow_apy\nADA,71%,4.1%\nDJED,▒▒▒,▒▒▒", "2 USDM"],
  ["Cardano DEX fee heatmap", 62, "Average swap fee paid per DEX by hour of day.", "dex,hour,avg_fee_ada\nminswap,14,0.31\n▒▒▒,▒▒,▒▒▒", "1 USDM"],
  ["Genius Yield order flow", 74, "Limit-order placements and fills on Genius Yield, 15-minute buckets.", "bucket,placed,filled\n05:00,214,131\n05:15,▒▒▒,▒▒▒", "3 USDM"],
];

const ARCHIVED: Array<[string, number, number, string, string]> = [
  ["NIGHT/ADA launch-day flow", 190, 150, "Order flow during the first 24 hours of NIGHT trading.", "hour,buys_ada,sells_ada\n00:00,820k,410k\n01:00,640k,390k"],
  ["SNEK/ADA 4-hour signal", 172, 128, "Direction and confidence for SNEK/ADA over four hours.", "pair        SNEK/ADA\nhorizon     240 min\ndirection   short\nconfidence  0.71"],
  ["ADA exchange net flows", 160, 110, "Daily net ADA flows to and from the five largest exchanges.", "day,net_ada\n02 Oct,-12.4M\n03 Oct,-3.1M"],
  ["MIN staking APR history", 140, 96, "Daily MIN staking APR over the last 30 days.", "day,apr_pct\n01 Oct,9.8\n02 Oct,9.6"],
  ["DEX aggregator routes", 120, 80, "Most common multi-hop routes chosen by DexHunter.", "route,share\nADA→MIN,18%\nADA→SNEK→MIN,6%"],
];

let counter = 0;
const id = (title: string) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${counter++}`;

export function sampleDaisy(): DaisyState {
  return {
    active: CURRENT.map(([title, hours, description, preview, price]) => ({ id: id(title), title, uploadedAt: at(hours), description, preview, price })),
    archived: ARCHIVED.map(([title, uploaded, archivedHours, description, preview]) => ({
      id: id(title), title, uploadedAt: at(uploaded), archivedAt: at(archivedHours), description, preview, price: "1 USDM",
    })),
  };
}

const NEXT: Array<[string, string, string, string]> = [
  ["INDY/ADA 30-min signal", "Direction and confidence for INDY/ADA over 30 minutes.", "pair        INDY/ADA\nhorizon     30 min\ndirection   ▒▒▒▒ (unlock)", "5 USDM"],
  ["Splash pool imbalance", "Pools on Splash whose reserves drifted more than 5% from the oracle price.", "pool,drift_pct\nSNEK/ADA,6.2\n▒▒▒,▒▒▒", "2 USDM"],
  ["ADA funding-rate snapshot", "Perpetual funding rates for ADA across major venues.", "venue,funding_8h\nvenue_a,0.011%\n▒▒▒,▒▒▒", "1 USDM"],
  ["HOSKY/ADA breakout alert", "A volume and price breakout on HOSKY/ADA.", "window,volume_x_baseline\n15m,5.1x\n1h,▒▒▒", "3 USDM"],
];

/** A new dataset to "upload" in the preview. */
export function nextSampleUpload(): PetalDataset {
  const [title, description, preview, price] = NEXT[counter % NEXT.length];
  return { id: id(title), title, uploadedAt: new Date().toISOString(), description, preview, price };
}

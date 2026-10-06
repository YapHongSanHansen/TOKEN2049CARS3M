import { chainModeFrom, fromRepoRoot, sha256Hex, toUnits, type ChainMode } from "@carsem/shared";

export type Category = "signal" | "flight" | "hotel" | "product";
export const CATEGORIES: Category[] = ["signal", "flight", "hotel", "product"];

export interface Config {
  mode: ChainMode;
  port: number;
  publicUrl: string;
  /** The web app (onboarding page, dashboard). */
  frontendUrl: string;
  /** The agent gateway (custody of agent wallets + MCP). */
  gatewayUrl: string;
  /** Where users' AI apps reach the gateway (MCP / REST). Defaults to gatewayUrl. */
  gatewayPublicUrl: string;
  /** Shared secret for service-to-service calls between carsem-api and the gateway. */
  serviceToken: string;
  dbPath: string;
  usdmAsset: string;
  prices: Record<Category, bigint>;
  publicAccessPrice: bigint;
  /** After a default, proceeds beyond the debt go to the platform (as drawn) or back to the user. */
  defaultSurplusTo: "platform" | "user";
  loanFeeBps: bigint;
  loanMax: bigint;
  loanDeadlineMs: number;
  defaultCheckIntervalMs: number;
  /** Minimum synced items before a loan can lock them as collateral. */
  minSyncItems: number;
  starter: { ada: bigint; usdm: bigint };
  l1Confirmations: number;
  bundleKey: Buffer;
  /** Ed25519 seed of CARSEM's credential-issuer key (did:web of the platform). */
  issuerSeed: Buffer;
  dexOutcome: "auto" | "win" | "loss";
  adaPriceUsdm: number;
  sim: { treasurySeed: string; marketMakerSeed: string };
  preprod: {
    blockfrost: { baseUrl: string; projectId: string };
    facilitatorUrl: string;
    treasuryMnemonic: string;
    marketMakerMnemonic: string;
  };
}

const str = (env: NodeJS.ProcessEnv, name: string, fallback = "") => env[name]?.trim() || fallback;
const num = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = chainModeFrom(env.CHAIN_MODE);
  const port = num(env, "PORT", 4021);
  const keyHex = str(env, "BUNDLE_KEY");
  if (keyHex && !/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("BUNDLE_KEY must be 32 bytes of hex");
  if (!keyHex && mode === "preprod") throw new Error("Set BUNDLE_KEY (32 bytes hex) before running on preprod.");
  const bundleKeyHex = keyHex || sha256Hex("carsem-dev-bundle-key");
  const dexOutcome = str(env, "DEX_SIM_OUTCOME", "auto");
  if (dexOutcome !== "auto" && dexOutcome !== "win" && dexOutcome !== "loss") throw new Error("DEX_SIM_OUTCOME must be auto, win or loss");
  const surplus = str(env, "DEFAULT_SURPLUS_TO", "platform");
  if (surplus !== "platform" && surplus !== "user") throw new Error("DEFAULT_SURPLUS_TO must be platform or user");
  const config: Config = {
    mode,
    port,
    publicUrl: str(env, "PUBLIC_URL", `http://localhost:${port}`).replace(/\/$/, ""),
    frontendUrl: str(env, "FRONTEND_URL", "http://localhost:5173").replace(/\/$/, ""),
    gatewayUrl: str(env, "GATEWAY_URL", "http://localhost:4031").replace(/\/$/, ""),
    gatewayPublicUrl: str(env, "GATEWAY_PUBLIC_URL", str(env, "GATEWAY_URL", "http://localhost:4031")).replace(/\/$/, ""),
    serviceToken: str(env, "SERVICE_TOKEN", "dev-service-token"),
    dbPath: fromRepoRoot(str(env, "DB_PATH", "./data/carsem.db")),
    usdmAsset: str(env, "USDM_ASSET", "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d"),
    prices: {
      signal: toUnits(str(env, "PRICE_SIGNAL_USDM", "5")),
      flight: toUnits(str(env, "PRICE_FLIGHT_USDM", "1")),
      hotel: toUnits(str(env, "PRICE_HOTEL_USDM", "1")),
      product: toUnits(str(env, "PRICE_PRODUCT_USDM", "1")),
    },
    publicAccessPrice: toUnits(str(env, "PUBLIC_ACCESS_PRICE_USDM", "1")),
    defaultSurplusTo: surplus,
    loanFeeBps: BigInt(num(env, "LOAN_FEE_BPS", 200)),
    loanMax: toUnits(str(env, "LOAN_MAX_USDM", "10")),
    loanDeadlineMs: num(env, "LOAN_DEADLINE_SECONDS", 300) * 1000,
    defaultCheckIntervalMs: num(env, "DEFAULT_CHECK_INTERVAL_MS", 10_000),
    minSyncItems: num(env, "MIN_SYNC_ITEMS", 3),
    starter: {
      ada: toUnits(str(env, "STARTER_ADA", mode === "preprod" ? "5" : "100")),
      usdm: toUnits(str(env, "STARTER_USDM", "0.05")),
    },
    l1Confirmations: num(env, "L1_CONFIRMATIONS", 0),
    bundleKey: Buffer.from(bundleKeyHex, "hex"),
    issuerSeed: Buffer.from(sha256Hex(`carsem-issuer:${bundleKeyHex}`), "hex"),
    dexOutcome,
    adaPriceUsdm: num(env, "ADA_PRICE_USDM", 0.45),
    sim: {
      treasurySeed: str(env, "SIM_TREASURY_SEED", "carsem-treasury"),
      marketMakerSeed: str(env, "SIM_MARKET_MAKER_SEED", "carsem-dex-pool"),
    },
    preprod: {
      blockfrost: {
        baseUrl: str(env, "BLOCKFROST_BASE_URL", "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/$/, ""),
        projectId: str(env, "BLOCKFROST_PROJECT_ID"),
      },
      facilitatorUrl: str(env, "FACILITATOR_URL", "http://localhost:4022").replace(/\/$/, ""),
      treasuryMnemonic: str(env, "TREASURY_MNEMONIC"),
      marketMakerMnemonic: str(env, "MARKET_MAKER_MNEMONIC"),
    },
  };
  if (mode === "preprod") {
    if (!config.preprod.blockfrost.projectId.startsWith("preprod")) throw new Error("Set BLOCKFROST_PROJECT_ID to a preprod project id.");
    if (config.preprod.treasuryMnemonic.split(/\s+/).length < 12) throw new Error("Set TREASURY_MNEMONIC (the lender/seller wallet).");
    if (config.serviceToken === "dev-service-token") throw new Error("Set SERVICE_TOKEN to a random secret on preprod.");
  }
  return config;
}

import { chainModeFrom, fromRepoRoot, sha256Hex, toUnits, type ChainMode } from "@carsem/shared";

export interface Config {
  mode: ChainMode;
  port: number;
  publicUrl: string;
  dbPath: string;
  usdmAsset: string;
  signalPrice: bigint;
  loanFeeBps: bigint;
  loanMax: bigint;
  loanDeadlineMs: number;
  defaultCheckIntervalMs: number;
  l1Confirmations: number;
  bundleKey: Buffer;
  dexOutcome: "auto" | "win" | "loss";
  adaPriceUsdm: number;
  /** Agent API key seeded for the demo agent. */
  demoAgentKey: string;
  sim: { treasurySeed: string; marketMakerSeed: string; agentSeed: string };
  preprod: {
    blockfrost: { baseUrl: string; projectId: string };
    facilitatorUrl: string;
    treasuryMnemonic: string;
    marketMakerMnemonic: string;
    agentMnemonic: string;
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
  const dexOutcome = str(env, "DEX_SIM_OUTCOME", "auto");
  if (dexOutcome !== "auto" && dexOutcome !== "win" && dexOutcome !== "loss") throw new Error("DEX_SIM_OUTCOME must be auto, win or loss");
  const config: Config = {
    mode,
    port,
    publicUrl: str(env, "PUBLIC_URL", `http://localhost:${port}`).replace(/\/$/, ""),
    dbPath: fromRepoRoot(str(env, "DB_PATH", "./data/carsem.db")),
    usdmAsset: str(env, "USDM_ASSET", "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d"),
    signalPrice: toUnits(str(env, "SIGNAL_PRICE_USDM", "5")),
    loanFeeBps: BigInt(num(env, "LOAN_FEE_BPS", 200)),
    loanMax: toUnits(str(env, "LOAN_MAX_USDM", "10")),
    loanDeadlineMs: num(env, "LOAN_DEADLINE_SECONDS", 300) * 1000,
    defaultCheckIntervalMs: num(env, "DEFAULT_CHECK_INTERVAL_MS", 10_000),
    l1Confirmations: num(env, "L1_CONFIRMATIONS", 0),
    // Dev fallback only; preprod refuses to start without a real key (above).
    bundleKey: Buffer.from(keyHex || sha256Hex("carsem-dev-bundle-key"), "hex"),
    dexOutcome,
    adaPriceUsdm: num(env, "ADA_PRICE_USDM", 0.45),
    demoAgentKey: str(env, "CARSEM_AGENT_KEY", "dev-agent-key"),
    sim: {
      treasurySeed: str(env, "SIM_TREASURY_SEED", "carsem-treasury"),
      marketMakerSeed: str(env, "SIM_MARKET_MAKER_SEED", "carsem-dex-pool"),
      agentSeed: str(env, "SIM_AGENT_SEED", "carsem-agent"),
    },
    preprod: {
      blockfrost: {
        baseUrl: str(env, "BLOCKFROST_BASE_URL", "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/$/, ""),
        projectId: str(env, "BLOCKFROST_PROJECT_ID"),
      },
      facilitatorUrl: str(env, "FACILITATOR_URL", "http://localhost:4022").replace(/\/$/, ""),
      treasuryMnemonic: str(env, "TREASURY_MNEMONIC"),
      marketMakerMnemonic: str(env, "MARKET_MAKER_MNEMONIC"),
      agentMnemonic: str(env, "AGENT_MNEMONIC"),
    },
  };
  if (mode === "preprod") {
    if (!config.preprod.blockfrost.projectId.startsWith("preprod")) throw new Error("Set BLOCKFROST_PROJECT_ID to a preprod project id.");
    if (config.preprod.treasuryMnemonic.split(/\s+/).length < 12) throw new Error("Set TREASURY_MNEMONIC (the lender/seller wallet).");
  }
  return config;
}

import { config as loadEnv } from "dotenv";
import { chainModeFrom, fromRepoRoot, rootEnvPaths, sha256Hex, toUnits, type ChainMode } from "@carsem/shared";

loadEnv({ path: rootEnvPaths(), quiet: true });

export interface GatewayConfig {
  mode: ChainMode;
  /** carsem-api, the platform. */
  apiUrl: string;
  port: number;
  /** Where users' AI apps reach this gateway. */
  publicUrl: string;
  serviceToken: string;
  /** Encrypts the hosted agent wallets at rest. */
  walletKey: Buffer;
  dbPath: string;
  maxPayment: bigint;
  tradeSizeAda: number;
  openai: { apiKey: string; model: string };
  preprod: { blockfrost: { baseUrl: string; projectId: string } };
}

const str = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

export function loadGatewayConfig(): GatewayConfig {
  const mode = chainModeFrom(process.env.CHAIN_MODE);
  const port = Number(str("GATEWAY_PORT", str("AGENT_PORT", "4031")));
  const walletKeyHex = str("WALLET_KEY");
  if (walletKeyHex && !/^[0-9a-fA-F]{64}$/.test(walletKeyHex)) throw new Error("WALLET_KEY must be 32 bytes of hex");
  if (mode === "preprod" && !walletKeyHex) throw new Error("Set WALLET_KEY (32 bytes hex) before holding real preprod wallets.");
  const serviceToken = str("SERVICE_TOKEN", "dev-service-token");
  if (mode === "preprod" && serviceToken === "dev-service-token") throw new Error("Set SERVICE_TOKEN to a random secret on preprod.");
  return {
    mode,
    apiUrl: str("CARSEM_API_URL", "http://localhost:4021").replace(/\/$/, ""),
    port,
    publicUrl: str("GATEWAY_PUBLIC_URL", `http://localhost:${port}`).replace(/\/$/, ""),
    serviceToken,
    walletKey: Buffer.from(walletKeyHex || sha256Hex("carsem-dev-wallet-key"), "hex"),
    dbPath: fromRepoRoot(str("GATEWAY_DB_PATH", "./data/gateway.db")),
    maxPayment: toUnits(str("AGENT_MAX_PAYMENT_USDM", "60")),
    tradeSizeAda: Number(str("AGENT_TRADE_SIZE_ADA", "400")),
    openai: { apiKey: str("OPENAI_API_KEY"), model: str("OPENAI_MODEL") },
    preprod: {
      blockfrost: { baseUrl: str("BLOCKFROST_BASE_URL", "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/$/, ""), projectId: str("BLOCKFROST_PROJECT_ID") },
    },
  };
}

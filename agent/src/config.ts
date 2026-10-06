import { config as loadEnv } from "dotenv";
import { chainModeFrom, rootEnvPath, toUnits, type ChainMode } from "@carsem/shared";

loadEnv({ path: rootEnvPath(), quiet: true });

export interface AgentConfig {
  mode: ChainMode;
  apiUrl: string;
  agentId: string;
  agentKey: string;
  maxPayment: bigint;
  tradeSizeAda: number;
  port: number;
  anthropicConfigured: boolean;
  model: string;
  sim: { agentSeed: string };
  preprod: { mnemonic: string; blockfrost: { baseUrl: string; projectId: string } };
}

const str = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

export function loadAgentConfig(): AgentConfig {
  return {
    mode: chainModeFrom(process.env.CHAIN_MODE),
    apiUrl: str("CARSEM_API_URL", "http://localhost:4021").replace(/\/$/, ""),
    agentId: str("CARSEM_AGENT_ID", "agent-demo"),
    agentKey: str("CARSEM_AGENT_KEY", "dev-agent-key"),
    maxPayment: toUnits(str("AGENT_MAX_PAYMENT_USDM", "60")),
    tradeSizeAda: Number(str("AGENT_TRADE_SIZE_ADA", "400")),
    port: Number(str("AGENT_PORT", "4031")),
    // The SDK also resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    anthropicConfigured: !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_PROFILE?.trim()),
    model: str("AGENT_MODEL", "claude-opus-5"),
    sim: { agentSeed: str("SIM_AGENT_SEED", "carsem-agent") },
    preprod: {
      mnemonic: str("AGENT_MNEMONIC"),
      blockfrost: { baseUrl: str("BLOCKFROST_BASE_URL", "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/$/, ""), projectId: str("BLOCKFROST_PROJECT_ID") },
    },
  };
}

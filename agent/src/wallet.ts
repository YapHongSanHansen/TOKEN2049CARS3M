/**
 * The agent's wallet: an x402 ClientCardanoSigner plus balance reads.
 *   preprod    the official @x402/cardano reference signer (Evolution SDK, mnemonic, Blockfrost)
 *   simulated  an ed25519 wallet whose transfers carsem-api's ledger settles
 * Either way the agent signs its own payments; nobody else can move its funds.
 */
import { toClientCardanoSigner, type ClientCardanoSigner } from "@x402/cardano";
import { LOVELACE, NETWORK, SimWallet } from "@carsem/shared";
import { api } from "./api.js";
import type { AgentConfig } from "./config.js";

export interface AgentWallet {
  address: string;
  signer: ClientCardanoSigner;
  /** asset -> base units */
  balances(): Promise<Record<string, bigint>>;
}

export function simWallet(apiUrl: string, seed: string): AgentWallet {
  const wallet = new SimWallet(seed);
  return {
    address: wallet.address,
    signer: {
      getAddress: () => wallet.address,
      buildAndSignPaymentTransaction(input) {
        const { encoded, tx } = wallet.signTx({ to: input.payTo, asset: input.asset, amount: input.amount, validUntil: Date.now() + input.maxTimeoutSeconds * 1000 });
        return { transaction: encoded, nonce: tx.body.nonce };
      },
    },
    async balances() {
      const { raw } = await api<{ raw: Record<string, string> }>(apiUrl, `/sim/balances/${wallet.address}`);
      return Object.fromEntries(Object.entries(raw).map(([asset, amount]) => [asset, BigInt(amount)]));
    },
  };
}

export function preprodWallet(mnemonic: string, blockfrost: { baseUrl: string; projectId: string }): AgentWallet {
  if (mnemonic.split(/\s+/).length < 12) throw new Error("Set AGENT_MNEMONIC to the agent's preprod wallet.");
  if (!blockfrost.projectId.startsWith("preprod")) throw new Error("Set BLOCKFROST_PROJECT_ID to a preprod project id.");
  const signer = toClientCardanoSigner({ mnemonic, network: NETWORK, provider: { blockfrost } });
  const address = signer.getAddress();
  return {
    address,
    signer,
    async balances() {
      const response = await fetch(`${blockfrost.baseUrl}/addresses/${address}`, { headers: { project_id: blockfrost.projectId }, signal: AbortSignal.timeout(15_000) });
      if (response.status === 404) return {};
      if (!response.ok) throw new Error(`Blockfrost /addresses returned ${response.status}`);
      const { amount } = await response.json() as { amount: Array<{ unit: string; quantity: string }> };
      return Object.fromEntries(amount.map(({ unit, quantity }) => [unit === LOVELACE ? LOVELACE : `${unit.slice(0, 56)}.${unit.slice(56)}`, BigInt(quantity)]));
    },
  };
}

export function agentWallet(config: AgentConfig): AgentWallet {
  return config.mode === "preprod" ? preprodWallet(config.preprod.mnemonic, config.preprod.blockfrost) : simWallet(config.apiUrl, config.sim.agentSeed);
}

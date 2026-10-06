import type { FacilitatorClient } from "@x402/core/server";
import type { ChainMode } from "@carsem/shared";

/** Wallets carsem-api signs for. The market maker pays simulated DEX profits. */
export type WalletRole = "treasury" | "marketMaker";

export interface ChainTx { txHash: string; explorerUrl: string }

export interface Chain {
  readonly mode: ChainMode;
  /** Verifies and settles x402 payments: the Java facilitator on preprod, the ledger when simulated. */
  readonly facilitator: FacilitatorClient;
  readonly treasuryAddress: string;
  readonly marketMakerAddress: string;
  /** Sends `amount` base units of `asset` and waits until the chain has it. */
  transfer(from: WalletRole, to: string, asset: string, amount: bigint, metadata?: Record<string, unknown>): Promise<ChainTx>;
  /** Several assets to one address (one transaction on preprod). */
  sendAssets(from: WalletRole, to: string, assets: Record<string, bigint>, metadata?: Record<string, unknown>): Promise<ChainTx>;
  /** Writes a label-674 metadata transaction from the treasury (decision log / proof of delivery). */
  logDecision(message: string[]): Promise<ChainTx>;
  /** asset -> base units. */
  balances(address: string): Promise<Record<string, string>>;
  /** The transaction hash inside an x402 Cardano payment payload. */
  txHashOf(encodedTransaction: string): string;
  /** Unix ms after which that payment can no longer settle (its TTL). */
  paymentValidUntil(encodedTransaction: string): number;
  explorerTx(hash: string): string;
  explorerAddress(address: string): string;
}

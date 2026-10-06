/**
 * CHAIN_MODE=simulated: an account ledger in SQLite that settles ed25519-signed
 * transfers (see shared/src/simchain.ts), plus an x402 facilitator over it.
 * Everything above the chain (offers, headers, verify/settle, receipts) is the
 * official x402 SDK, unchanged.
 */
import { randomUUID } from "node:crypto";
import {
  CARDANO_ADDRESS_REGEX, LOVELACE, NETWORK, SIM_FEE_LOVELACE, SimWallet, decodeSimTx, sha256Hex, simTxHash, simTxSignatureValid,
  toUnits, type SimTx,
} from "@carsem/shared";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { Chain, ChainTx, WalletRole } from "./types.js";

export class SimLedger {
  constructor(private readonly db: Db) {}

  balance(address: string, asset: string): bigint {
    const row = this.db.get<{ amount: string }>("SELECT amount FROM sim_balances WHERE address = ? AND asset = ?", address, asset);
    return BigInt(row?.amount ?? "0");
  }

  balances(address: string): Record<string, string> {
    const rows = this.db.all<{ asset: string; amount: string }>("SELECT asset, amount FROM sim_balances WHERE address = ? ORDER BY asset", address);
    return Object.fromEntries(rows.map(r => [r.asset, r.amount]));
  }

  private add(address: string, asset: string, delta: bigint) {
    const next = this.balance(address, asset) + delta;
    if (next < 0n) throw new Error(`sim_insufficient_funds: ${address} ${asset}`);
    this.db.run("INSERT INTO sim_balances (address, asset, amount) VALUES (?, ?, ?) ON CONFLICT (address, asset) DO UPDATE SET amount = excluded.amount", address, asset, next.toString());
  }

  /** Faucet / genesis mint. */
  mint(address: string, asset: string, amount: bigint): string {
    const hash = sha256Hex(`mint:${address}:${asset}:${amount}:${randomUUID()}`);
    this.db.transaction(() => {
      this.add(address, asset, amount);
      this.db.run("INSERT INTO sim_txs (hash, kind, to_address, asset, amount, body_json, created_at) VALUES (?, 'mint', ?, ?, ?, ?, ?)",
        hash, address, asset, amount.toString(), JSON.stringify({ faucet: true }), Date.now());
    });
    return hash;
  }

  hasTx(hash: string) { return !!this.db.get("SELECT 1 FROM sim_txs WHERE hash = ?", hash); }

  getTx(hash: string) {
    const row = this.db.get<{ hash: string; kind: string; body_json: string; created_at: number }>("SELECT * FROM sim_txs WHERE hash = ?", hash);
    return row && { hash: row.hash, kind: row.kind, createdAt: new Date(row.created_at).toISOString(), ...JSON.parse(row.body_json) };
  }

  /** Why `tx` cannot settle now, or undefined when it can. */
  check(tx: SimTx, now = Date.now()): string | undefined {
    const b = tx.body;
    if (!simTxSignatureValid(tx)) return "sim_invalid_signature";
    if (b.network !== NETWORK) return "sim_network_mismatch";
    if (!Number.isSafeInteger(b.validUntil) || b.validUntil <= now) return "sim_transaction_expired";
    if (!/^[0-9a-f]{64}#\d+$/.test(b.nonce)) return "sim_invalid_nonce";
    if (this.db.get("SELECT 1 FROM sim_nonces WHERE nonce = ?", b.nonce)) return "sim_nonce_already_spent";
    let lovelaceNeeded = SIM_FEE_LOVELACE;
    if (b.to !== undefined) {
      if (!CARDANO_ADDRESS_REGEX.test(b.to) || !b.asset || !/^[1-9]\d*$/.test(b.amount ?? "")) return "sim_invalid_transfer";
      const amount = BigInt(b.amount!);
      if (b.asset === LOVELACE) lovelaceNeeded += amount;
      else if (this.balance(b.from, b.asset) < amount) return "sim_insufficient_funds";
    }
    if (this.balance(b.from, LOVELACE) < lovelaceNeeded) return "sim_insufficient_ada_for_fee";
    return undefined;
  }

  /** Settles `tx` atomically. Idempotent: an already-settled transaction returns its hash. */
  apply(tx: SimTx): string {
    const hash = simTxHash(tx.body);
    return this.db.transaction(() => {
      if (this.hasTx(hash)) return hash;
      const reason = this.check(tx);
      if (reason) throw new Error(reason);
      const b = tx.body;
      this.add(b.from, LOVELACE, -SIM_FEE_LOVELACE);
      if (b.to !== undefined) {
        this.add(b.from, b.asset!, -BigInt(b.amount!));
        this.add(b.to, b.asset!, BigInt(b.amount!));
      }
      this.db.run("INSERT INTO sim_nonces (nonce, tx_hash) VALUES (?, ?)", b.nonce, hash);
      this.db.run("INSERT INTO sim_txs (hash, kind, from_address, to_address, asset, amount, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        hash, b.to !== undefined ? "transfer" : "metadata", b.from, b.to ?? null, b.asset ?? null, b.amount ?? null,
        JSON.stringify({ ...b, signature: tx.signature, fee: SIM_FEE_LOVELACE.toString() }), Date.now());
      return hash;
    });
  }
}

/** An x402 facilitator over the simulated ledger, mirroring the Java facilitator's contract. */
export class SimFacilitator implements FacilitatorClient {
  constructor(private readonly ledger: SimLedger) {}

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { assetTransferMethods: ["default"], l1Confirmations: { minimum: 0, maximum: 1 }, simulated: true } }],
      extensions: [], signers: {},
    };
  }

  private inspect(payload: PaymentPayload, requirements: PaymentRequirements): { tx?: SimTx; reason?: string; message?: string } {
    let tx: SimTx;
    try { tx = decodeSimTx(String(payload.payload.transaction)); }
    catch (error) { return { reason: "sim_transaction_decode_failed", message: (error as Error).message }; }
    const b = tx.body;
    if (requirements.scheme !== "exact" || requirements.network !== NETWORK) return { tx, reason: "unsupported_scheme" };
    if (b.to !== requirements.payTo) return { tx, reason: "sim_recipient_mismatch" };
    if (b.asset !== requirements.asset) return { tx, reason: "sim_asset_mismatch" };
    if (BigInt(b.amount ?? "0") < BigInt(requirements.amount)) return { tx, reason: "sim_amount_insufficient" };
    if (b.nonce !== payload.payload.nonce) return { tx, reason: "sim_nonce_mismatch" };
    if (b.validUntil > Date.now() + (requirements.maxTimeoutSeconds + 60) * 1000) return { tx, reason: "sim_ttl_too_far" };
    return { tx };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const { tx, reason, message } = this.inspect(payload, requirements);
    const payer = tx?.body.from;
    if (reason) return { isValid: false, invalidReason: reason, invalidMessage: message, payer };
    // A retry of an already-settled payment is still the same valid payment.
    if (this.ledger.hasTx(simTxHash(tx!.body))) return { isValid: true, payer };
    const problem = this.ledger.check(tx!);
    return problem ? { isValid: false, invalidReason: problem, payer } : { isValid: true, payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const { tx, reason, message } = this.inspect(payload, requirements);
    const base = { network: requirements.network, payer: tx?.body.from };
    if (reason) return { ...base, success: false, errorReason: reason, errorMessage: message, transaction: "" };
    try {
      return { ...base, success: true, transaction: this.ledger.apply(tx!) };
    } catch (error) {
      return { ...base, success: false, errorReason: (error as Error).message, transaction: "" };
    }
  }
}

export interface SimulatedChain extends Chain { readonly ledger: SimLedger }

export function createSimulatedChain(config: Config, db: Db): SimulatedChain {
  const ledger = new SimLedger(db);
  const wallets: Record<WalletRole, SimWallet> = {
    treasury: new SimWallet(config.sim.treasurySeed),
    marketMaker: new SimWallet(config.sim.marketMakerSeed),
  };
  // Genesis: give the house wallets something to lend and pay out, once.
  for (const wallet of Object.values(wallets)) {
    if (ledger.balance(wallet.address, LOVELACE) === 0n) ledger.mint(wallet.address, LOVELACE, toUnits("10000"));
    if (ledger.balance(wallet.address, config.usdmAsset) === 0n) ledger.mint(wallet.address, config.usdmAsset, toUnits("10000"));
  }
  const explorerTx = (hash: string) => `${config.publicUrl}/sim/txs/${hash}`;
  const send = (role: WalletRole, fields: Parameters<SimWallet["signTx"]>[0]): ChainTx => {
    const { tx } = wallets[role].signTx(fields);
    const txHash = ledger.apply(tx);
    return { txHash, explorerUrl: explorerTx(txHash) };
  };
  return {
    mode: "simulated",
    ledger,
    facilitator: new SimFacilitator(ledger),
    treasuryAddress: wallets.treasury.address,
    marketMakerAddress: wallets.marketMaker.address,
    async transfer(from, to, asset, amount, metadata) {
      return send(from, { to, asset, amount: amount.toString(), validUntil: Date.now() + 60_000, metadata: metadata && { 674: metadata } });
    },
    async sendAssets(from, to, assets, metadata) {
      // The simulated ledger moves one asset per transaction; return the last hash.
      let last: ChainTx | undefined;
      for (const [asset, amount] of Object.entries(assets)) {
        if (amount > 0n) last = send(from, { to, asset, amount: amount.toString(), validUntil: Date.now() + 60_000, metadata: metadata && { 674: metadata } });
      }
      if (!last) throw new Error("Nothing to send");
      return last;
    },
    async logDecision(message) {
      return send("treasury", { validUntil: Date.now() + 60_000, metadata: { 674: { msg: message } } });
    },
    async balances(address) { return ledger.balances(address); },
    txHashOf(encoded) { return simTxHash(decodeSimTx(encoded).body); },
    paymentValidUntil(encoded) { return decodeSimTx(encoded).body.validUntil; },
    explorerTx,
    explorerAddress: address => `${config.publicUrl}/sim/balances/${address}`,
  };
}

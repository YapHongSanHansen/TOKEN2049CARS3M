/**
 * The simulated chain's transaction format.
 *
 * In CHAIN_MODE=simulated the x402 protocol runs unchanged (402 offer,
 * PAYMENT-SIGNATURE, facilitator verify + settle, PAYMENT-RESPONSE), but the
 * "transaction" inside the payment payload is this ed25519-signed transfer
 * instead of Cardano CBOR, and carsem-api's ledger settles it. Addresses keep
 * the `addr_test1` prefix so the official ExactCardanoScheme accepts them.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Hex } from "./json.js";
import { NETWORK } from "./units.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Network fee charged in lovelace for every simulated transaction. */
export const SIM_FEE_LOVELACE = 170_000n;

export interface SimTxBody {
  v: 1;
  network: string;
  from: string;
  pubKey: string;
  /** Recipient. Absent for a metadata-only transaction. */
  to?: string;
  asset?: string;
  amount?: string;
  /** `<64 hex>#<index>`, the replay-protection reference, as in the Cardano scheme. */
  nonce: string;
  /** Unix ms after which the transaction cannot settle. */
  validUntil: number;
  /** CIP-20 style message (label 674), e.g. a delivery proof hash. */
  metadata?: Record<string, unknown>;
}

export interface SimTx { body: SimTxBody; signature: string }

export const simAddress = (publicKeyHex: string) => `addr_test1sim${sha256Hex(Buffer.from(publicKeyHex, "hex")).slice(0, 56)}`;
export const simTxHash = (body: SimTxBody) => sha256Hex(canonicalJson(body));
export const isSimAddress = (address: string) => /^addr_test1sim[0-9a-f]{56}$/.test(address);

export class SimWallet {
  readonly address: string;
  readonly publicKeyHex: string;
  private readonly key: KeyObject;

  /** Any string works as a seed; the same seed always yields the same wallet. */
  constructor(seed: string) {
    const secret = Buffer.from(sha256Hex(`carsem-sim-wallet:${seed}`), "hex");
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, secret]), format: "der", type: "pkcs8" });
    const spki = createPublicKey(this.key).export({ format: "der", type: "spki" });
    this.publicKeyHex = Buffer.from(spki.subarray(spki.length - 32)).toString("hex");
    this.address = simAddress(this.publicKeyHex);
  }

  signTx(fields: Omit<SimTxBody, "v" | "network" | "from" | "pubKey" | "nonce"> & { nonce?: string }): { tx: SimTx; txHash: string; encoded: string } {
    const body: SimTxBody = {
      v: 1, network: NETWORK, from: this.address, pubKey: this.publicKeyHex,
      nonce: fields.nonce ?? `${randomBytes(32).toString("hex")}#0`,
      validUntil: fields.validUntil,
      ...(fields.to !== undefined ? { to: fields.to, asset: fields.asset, amount: fields.amount } : {}),
      ...(fields.metadata ? { metadata: fields.metadata } : {}),
    };
    const signature = sign(null, Buffer.from(canonicalJson(body)), this.key).toString("hex");
    const tx = { body, signature };
    return { tx, txHash: simTxHash(body), encoded: encodeSimTx(tx) };
  }
}

export function encodeSimTx(tx: SimTx): string {
  return Buffer.from(`SIMTX:${JSON.stringify(tx)}`).toString("base64");
}

export function isSimTransaction(encoded: string): boolean {
  try { return Buffer.from(encoded, "base64").subarray(0, 6).toString() === "SIMTX:"; } catch { return false; }
}

export function decodeSimTx(encoded: string): SimTx {
  const text = Buffer.from(encoded, "base64").toString();
  if (!text.startsWith("SIMTX:")) throw new Error("Not a simulated-chain transaction");
  const tx = JSON.parse(text.slice(6)) as SimTx;
  if (!tx?.body || typeof tx.signature !== "string" || tx.body.v !== 1) throw new Error("Malformed simulated transaction");
  return tx;
}

/** Signature valid and `from` is the address of the signing key. */
export function simTxSignatureValid(tx: SimTx): boolean {
  try {
    if (simAddress(tx.body.pubKey) !== tx.body.from) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(tx.body.pubKey, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalJson(tx.body)), key, Buffer.from(tx.signature, "hex"));
  } catch {
    return false;
  }
}

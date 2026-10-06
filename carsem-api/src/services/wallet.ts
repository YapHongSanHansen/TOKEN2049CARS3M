/**
 * Step 0 of onboarding: connect your own Cardano wallet (Lace, or any CIP-30 wallet).
 *
 * The browser asks the wallet to sign a one-time CARSEM message with CIP-30 `signData`. The result
 * is a CIP-8 COSE_Sign1 signature plus the COSE_Key, verified here with Evolution SDK. That proves
 * the user controls the address. Signing is free and moves no funds.
 *
 * In Masumi terms this wallet is the user's cold "collection" wallet. Earnings are paid to it and
 * it tops up the agent's hosted purchasing wallet, which keeps signing x402 payments on its own so
 * ChatGPT, Claude and curl can pay without a wallet popup.
 */
import { randomBytes } from "node:crypto";
import { AddressEras, COSE, KeyHash, VKey } from "@evolution-sdk/evolution";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";

const CHALLENGE_TTL_MS = 10 * 60_000;

export interface WalletAddress {
  hex: string;
  bech32: string;
  /** stake = reward address (the wallet account); base / enterprise = a payment address. */
  kind: "stake" | "base" | "enterprise";
  /** The key hash that must have signed: the stake credential for a stake address, else the payment credential. */
  keyHash: string;
}

export interface ProvenWallet extends WalletAddress { publicKey: string | null }

/** Parses a CIP-30 (hex) or bech32 testnet address that a single wallet key can sign for. */
export function parseWalletAddress(input: string): WalletAddress {
  const raw = input.trim();
  let hex: string;
  try { hex = /^[0-9a-f]+$/i.test(raw) ? raw.toLowerCase() : AddressEras.toHex(AddressEras.fromBech32(raw)); }
  catch { throw new HttpError(400, "That is not a Cardano address", "bad_address"); }
  const header = parseInt(hex.slice(0, 2), 16);
  if (Number.isNaN(header)) throw new HttpError(400, "That is not a Cardano address", "bad_address");
  if ((header & 0x0f) !== 0) {
    throw new HttpError(400, "Your wallet is on mainnet. CARSEM runs on the Cardano preprod testnet: switch your wallet to Preprod (in Lace: Settings → Network → Preprod) and connect again.", "wrong_network");
  }
  const type = header >> 4;
  // Key-hash credentials only: 0 = base (key, key), 6 = enterprise (key), 14 = reward (key).
  const kind = type === 14 ? "stake" : type === 0 ? "base" : type === 6 ? "enterprise" : undefined;
  if (!kind) throw new HttpError(400, "Connect a regular wallet. Script, pointer and Byron addresses can't sign in.", "unsupported_address");
  if (hex.length !== (kind === "base" ? 114 : 58)) throw new HttpError(400, "That is not a Cardano address", "bad_address");
  let bech32: string;
  try { bech32 = AddressEras.toBech32(AddressEras.fromHex(hex)); } catch { throw new HttpError(400, "That is not a Cardano address", "bad_address"); }
  return { hex, bech32, kind, keyHash: hex.slice(2, 58) };
}

const bytes = (value: unknown, name: string) => {
  if (typeof value !== "string" || !/^([0-9a-f]{2})+$/i.test(value)) throw new HttpError(400, `${name} must be the hex string your wallet returned from signData`);
  return Uint8Array.from(Buffer.from(value, "hex"));
};

/** The Ed25519 public key inside a CIP-30 COSE_Key (label -2), if it hashes to the expected key hash. */
function publicKeyOf(coseKey: Uint8Array, keyHash: string): string | null {
  const hex = Buffer.from(coseKey).toString("hex");
  // x (-2) => bytes(32). A kid header may come first, so try each match against the signer's key hash.
  for (let at = hex.indexOf("215820"); at >= 0; at = hex.indexOf("215820", at + 2)) {
    if (at % 2) continue;
    const key = hex.slice(at + 6, at + 6 + 64);
    try { if (key.length === 64 && KeyHash.toHex(KeyHash.fromVKey(VKey.fromBytes(Uint8Array.from(Buffer.from(key, "hex"))))) === keyHash) return key; }
    catch { /* not a key */ }
  }
  return null;
}

export class WalletAuth {
  constructor(private readonly db: Db, private readonly site: string) {}

  /** A one-time message for the wallet to sign. `payload` is its hex, ready for CIP-30 signData. */
  challenge(address: string) {
    const wallet = parseWalletAddress(address);
    const now = Date.now();
    this.db.run("DELETE FROM wallet_challenges WHERE expires_at < ?", now - 24 * 3600_000);
    // One line of printable ASCII: cardano-connect-with-wallet's signMessage hex-encodes per character
    // without zero padding, so newlines or non-ASCII characters would change the signed bytes.
    const message = [
      "Sign in to CARSEM. This proves you own this Cardano wallet; it is free and moves no funds.",
      `Wallet: ${wallet.bech32}`,
      `Site: ${this.site}`,
      `Nonce: ${randomBytes(16).toString("hex")}`,
      `Issued: ${new Date(now).toISOString()}`,
    ].join(" | ");
    const id = newId("wch");
    this.db.run("INSERT INTO wallet_challenges (id, address_hex, message, expires_at) VALUES (?, ?, ?, ?)", id, wallet.hex, message, now + CHALLENGE_TTL_MS);
    return {
      challengeId: id, address: wallet.bech32, signWith: wallet.hex, message,
      payload: Buffer.from(message, "utf8").toString("hex"), expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    };
  }

  /** Verifies the wallet's signData result `{ signature, key }` for a challenge. Each challenge works once. */
  verify(input: { challengeId?: unknown; signature?: unknown; key?: unknown }): ProvenWallet {
    const signature = bytes(input.signature, "signature");
    const key = bytes(input.key, "key");
    const row = this.db.get<{ address_hex: string; message: string; expires_at: number; used_at: number | null }>(
      "SELECT * FROM wallet_challenges WHERE id = ?", String(input.challengeId ?? ""));
    if (!row || row.used_at || row.expires_at < Date.now()) throw new HttpError(400, "This sign-in request expired. Connect your wallet again.", "challenge_expired");
    if (this.db.run("UPDATE wallet_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL", Date.now(), String(input.challengeId)).changes !== 1) {
      throw new HttpError(400, "This sign-in request was already used. Connect your wallet again.", "challenge_expired");
    }
    const wallet = parseWalletAddress(row.address_hex);
    const valid = COSE.SignData.verifyData(wallet.hex, wallet.keyHash, Uint8Array.from(Buffer.from(row.message, "utf8")), { signature, key });
    if (!valid) throw new HttpError(401, "The wallet signature doesn't match this wallet. Connect your wallet again.", "bad_signature");
    return { ...wallet, publicKey: publicKeyOf(key, wallet.keyHash) };
  }
}

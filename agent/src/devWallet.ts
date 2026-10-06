/**
 * A software stand-in for a CIP-30 browser wallet such as Lace, for the terminal and tests
 * (there is no browser extension there). It signs CARSEM's sign-in message exactly the way
 * Lace's `signData` does: a CIP-8 COSE_Sign1 made with the wallet's stake key, on preprod.
 */
import { COSE, KeyHash, PrivateKey } from "@evolution-sdk/evolution";
import { api } from "./api.js";

export interface DevWallet {
  name: string;
  /** CIP-30 style hex addresses: the reward (stake) address and a base payment address. */
  rewardAddress: string;
  paymentAddress: string;
  signData(addressHex: string, payloadHex: string): { signature: string; key: string };
}

export function devWallet(): DevWallet {
  const key = PrivateKey.fromBytes(PrivateKey.generate());
  const keyHash = KeyHash.toHex(KeyHash.fromVKey(PrivateKey.toPublicKey(key)));
  return {
    name: "dev-wallet",
    rewardAddress: `e0${keyHash}`,
    paymentAddress: `00${keyHash}${keyHash}`,
    signData(addressHex, payloadHex) {
      const signed = COSE.SignData.signData(addressHex, Uint8Array.from(Buffer.from(payloadHex, "hex")), key);
      return { signature: Buffer.from(signed.signature).toString("hex"), key: Buffer.from(signed.key).toString("hex") };
    },
  };
}

/** Connects a wallet the way the web app does (challenge → signData → verify) and returns the CARSEM key. */
export async function connectWallet(apiUrl: string, wallet: DevWallet, input: { name?: string } = {}) {
  const challenge = await api<{ challengeId: string; signWith: string; payload: string }>(apiUrl, "/onboarding/wallet/challenge", { body: { address: wallet.rewardAddress } });
  const signed = wallet.signData(challenge.signWith, challenge.payload);
  return api<{ apiKey: string; returning: boolean; profile: any }>(apiUrl, "/onboarding/wallet/verify", {
    body: { challengeId: challenge.challengeId, ...signed, walletName: wallet.name, paymentAddress: wallet.paymentAddress, name: input.name },
  });
}

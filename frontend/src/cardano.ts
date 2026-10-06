/**
 * The user's own Cardano wallet: Lace, connected with the Cardano Foundation's
 * cardano-connect-with-wallet (CIP-30 connect, testnet only, CIP-8 signMessage with the stake address).
 * carsem-api verifies the signature with Evolution SDK and returns the CARSEM key.
 */
import { NetworkType, Wallet } from "@cardano-foundation/cardano-connect-with-wallet-core";
import { post, type Profile } from "./api";

export const LACE = { id: "lace", networkHint: "Settings → Network → Preprod" };

const NAMES: Record<string, string> = {
  lace: "Lace", eternl: "Eternl", nami: "Nami", yoroi: "Yoroi", typhoncip30: "Typhon", vespr: "VESPR",
  gerowallet: "GeroWallet", nufi: "NuFi", begin: "Begin", flint: "Flint",
};

/** A wallet's display name from its CIP-30 id ("lace" → "Lace"). */
export const walletLabel = (id: string | null | undefined) => !id ? "Cardano wallet" : NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** Lace isn't on this page (Chrome only adds an extension to pages loaded after it was installed). */
export class LaceMissingError extends Error {}

/** The library's typed errors and Lace's own CIP-30 errors, in words a person can act on. */
function friendly(error: unknown): Error {
  const e = error as { name?: string; message?: string; info?: string; code?: number } | undefined;
  switch (e?.name) {
    case "WalletNotInstalledError":
    case "ExtensionNotInjectedError":
      return new LaceMissingError("Lace wasn't found in this browser.");
    case "WrongNetworkTypeError":
      return new Error(`Lace is on mainnet. CARSEM runs on the Cardano preprod testnet: in Lace open ${LACE.networkHint}, then connect again.`);
    case "WalletConnectError": {
      const fromLace = e.message?.split("The error coming from this wallet is: ")[1]?.replace(/\.\s*$/, "");
      return new Error(fromLace && fromLace !== "undefined" ? fromLace : "Lace didn't connect. Approve the request in Lace and try again.");
    }
  }
  if (e?.code === 3 || e?.code === -3) return new Error("You cancelled in Lace. Nothing was signed.");
  return new Error(e?.info ?? e?.message ?? "Lace returned an error");
}

export type ConnectStage = "connecting" | "signing" | "verifying";

/** Connect Lace (testnet only) → sign CARSEM's one-time message → verified by carsem-api. Same wallet, same account. */
export async function signInWithLace(onStage: (stage: ConnectStage) => void, name?: string) {
  onStage("connecting");
  await new Promise<void>((resolve, reject) => void Wallet.connect(LACE.id, NetworkType.TESTNET, resolve, reject))
    .catch(error => { throw friendly(error); });
  const stakeAddress = Wallet.stakeAddressObserver.get();
  if (!stakeAddress) throw new Error("Lace didn't share a Cardano account. Make sure Lace has a Cardano wallet on Preprod.");

  const challenge = await post<{ challengeId: string; message: string }>("/api/onboarding/wallet/challenge", { address: stakeAddress });
  onStage("signing");
  const signed = await new Promise<{ signature: string; key: string }>((resolve, reject) =>
    void Wallet.signMessage(challenge.message, (signature, key) => resolve({ signature, key: key ?? "" }), reject, NetworkType.TESTNET))
    .catch(error => { throw friendly(error); });

  onStage("verifying");
  return post<{ apiKey: string; returning: boolean; profile: Profile }>("/api/onboarding/wallet/verify", {
    challengeId: challenge.challengeId, ...signed, walletName: LACE.id, paymentAddress: Wallet.usedAddressesObserver.get()[0], name: name || undefined,
  });
}

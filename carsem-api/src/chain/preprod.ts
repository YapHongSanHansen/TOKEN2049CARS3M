/**
 * CHAIN_MODE=preprod: real Cardano preprod.
 *   - x402 verify/settle: the Java cardano-x402-facilitator over HTTP (FACILITATOR_URL).
 *     It holds no keys; it checks the payer-signed transaction and broadcasts it.
 *   - Loans, DEX payouts and the decision log: Evolution SDK wallets signed here.
 *   - Reads: Blockfrost.
 */
import { Address, Assets, Client, TransactionHash, preprod, type TransactionMetadatum } from "@evolution-sdk/evolution";
import { decodeCardanoTransaction, parseAssetUnit, slotToPosixMs } from "@x402/cardano";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { LOVELACE, NETWORK } from "@carsem/shared";
import type { Config } from "../config.js";
import type { Chain, ChainTx, WalletRole } from "./types.js";

/** JSON (strings ≤ 64 bytes, numbers, arrays, objects) as transaction metadata. */
function toMetadatum(value: unknown): TransactionMetadatum.TransactionMetadatum {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 64) throw new Error(`Metadata string over 64 bytes: ${value.slice(0, 20)}…`);
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") return BigInt(value);
  if (Array.isArray(value)) return value.map(toMetadatum);
  if (value && typeof value === "object") {
    return new Map(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toMetadatum(v)] as const));
  }
  throw new Error(`Unsupported metadata value ${String(value)}`);
}

function assetsOf(asset: string, amount: bigint) {
  if (asset === LOVELACE) return Assets.fromLovelace(amount);
  const { policyId, assetNameHex } = parseAssetUnit(asset);
  return Assets.addByHex(Assets.fromLovelace(0n), policyId, assetNameHex, amount);
}

export async function createPreprodChain(config: Config): Promise<Chain> {
  const { blockfrost } = config.preprod;
  const facilitatorUrl = config.preprod.facilitatorUrl;
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl, timeoutMs: 180_000 });
  const supported = await facilitator.getSupported().catch(error => {
    throw new Error(`Cannot reach the x402 facilitator at ${facilitatorUrl}. Start it with "npm run facilitator:up".`, { cause: error });
  });
  if (!supported.kinds.some(k => k.x402Version === 2 && k.scheme === "exact" && k.network === NETWORK)) {
    throw new Error(`The facilitator at ${facilitatorUrl} does not serve x402 v2 exact on ${NETWORK}.`);
  }

  const makeClient = (mnemonic: string) => Client.make(preprod).withBlockfrost(blockfrost).withSeed({ mnemonic });
  const clients: Record<WalletRole, ReturnType<typeof makeClient>> = {
    treasury: makeClient(config.preprod.treasuryMnemonic),
    marketMaker: makeClient(config.preprod.marketMakerMnemonic || config.preprod.treasuryMnemonic),
  };
  const addresses: Record<WalletRole, string> = {
    treasury: Address.toBech32(await clients.treasury.address()),
    marketMaker: Address.toBech32(await clients.marketMaker.address()),
  };

  // One transaction at a time per process, each awaited to confirmation, so a
  // following transaction never selects inputs the previous one spent.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const explorerTx = (hash: string) => `https://preprod.cardanoscan.io/transaction/${hash}`;

  async function submit(role: WalletRole, build: (tx: ReturnType<ReturnType<typeof makeClient>["newTx"]>) => ReturnType<ReturnType<typeof makeClient>["newTx"]>): Promise<ChainTx> {
    return serial(async () => {
      const client = clients[role];
      const built = await build(client.newTx()).build({ changeAddress: await client.address(), availableUtxos: await client.getWalletUtxos() });
      const hash = await (await built.sign()).submit();
      await client.awaitTx(hash, 5_000, 300_000);
      const txHash = TransactionHash.toHex(hash);
      return { txHash, explorerUrl: explorerTx(txHash) };
    });
  }

  return {
    mode: "preprod",
    facilitator,
    treasuryAddress: addresses.treasury,
    marketMakerAddress: addresses.marketMaker,
    transfer(from, to, asset, amount, metadata) {
      return submit(from, tx => {
        let next = tx.payToAddress({ address: Address.fromBech32(to), assets: assetsOf(asset, amount) });
        if (metadata) next = next.attachMetadata({ label: 674n, metadata: toMetadatum(metadata) });
        return next;
      });
    },
    logDecision(message) {
      // A minimal self-payment that carries the message; the fee is the cost of the log entry.
      return submit("treasury", tx => tx
        .payToAddress({ address: Address.fromBech32(addresses.treasury), assets: Assets.fromLovelace(1_500_000n) })
        .attachMetadata({ label: 674n, metadata: toMetadatum({ msg: message }) }));
    },
    async balances(address) {
      const response = await fetch(`${blockfrost.baseUrl}/addresses/${address}`, { headers: { project_id: blockfrost.projectId }, signal: AbortSignal.timeout(15_000) });
      if (response.status === 404) return {};
      if (!response.ok) throw new Error(`Blockfrost /addresses returned ${response.status}`);
      const body = await response.json() as { amount: Array<{ unit: string; quantity: string }> };
      return Object.fromEntries(body.amount.map(({ unit, quantity }) => [unit === LOVELACE ? LOVELACE : `${unit.slice(0, 56)}.${unit.slice(56)}`, quantity]));
    },
    txHashOf: encoded => decodeCardanoTransaction(encoded).txHash,
    paymentValidUntil(encoded) {
      const { ttlSlot } = decodeCardanoTransaction(encoded);
      return ttlSlot === undefined ? 0 : slotToPosixMs(NETWORK, ttlSlot);
    },
    explorerTx,
    explorerAddress: address => `https://preprod.cardanoscan.io/address/${address}`,
  };
}

/**
 * Enterprise data buyers. Each enterprise is its own x402 buyer with its own
 * wallet: simulated mode derives it from "enterprise-<name>", preprod uses
 * ENTERPRISE_MNEMONIC.
 */
import { LOVELACE, fromUnits, toUnits } from "@carsem/shared";
import { api } from "./api.js";
import type { GatewayConfig } from "./config.js";
import { preprodWallet, simWallet, type AgentWallet } from "./wallet.js";
import { paidFetch, type X402Step } from "./x402Client.js";

interface Listing { id: string; status: string; reason: string; loan?: { id: string; status: string; outstanding: string }; enterpriseOffers: Array<{ bidId: string; enterprise: string; price: number }> }

export function enterpriseWallet(config: GatewayConfig, enterprise: string): AgentWallet {
  return config.mode === "preprod"
    ? preprodWallet(process.env.ENTERPRISE_MNEMONIC?.trim() ?? "", config.preprod.blockfrost)
    : simWallet(config.apiUrl, `enterprise-${enterprise.toLowerCase()}`);
}

export async function enterpriseBalance(config: GatewayConfig, enterprise: string) {
  const wallet = enterpriseWallet(config, enterprise);
  const { usdmAsset } = await api<{ usdmAsset: string }>(config.apiUrl, "/health");
  const balances = await wallet.balances();
  return { enterprise, address: wallet.address, tUSDM: fromUnits(balances[usdmAsset] ?? 0n), tADA: fromUnits(balances[LOVELACE] ?? 0n) };
}

export async function buyBundle(config: GatewayConfig, input: { enterprise: string; bundleId?: string; onStep?: (step: X402Step) => void }) {
  const wallet = enterpriseWallet(config, input.enterprise);
  const { usdmAsset } = await api<{ usdmAsset: string }>(config.apiUrl, "/health");
  const listings = await api<Listing[]>(config.apiUrl, "/market/bundles");
  const matches = (o: { enterprise: string }) => o.enterprise.toLowerCase() === input.enterprise.toLowerCase();
  const bundle = listings.find(l => (input.bundleId ? l.id === input.bundleId : true) && l.enterpriseOffers.some(matches));
  if (!bundle) throw new Error(`No bundle on the market that ${input.enterprise} can buy${input.bundleId ? ` (bundle ${input.bundleId})` : ""}.`);
  const offer = bundle.enterpriseOffers.find(matches)!;
  const loanBefore = bundle.loan;

  const result = await paidFetch<any>(`${config.apiUrl}/market/bundles/${bundle.id}/buy?bid=${offer.bidId}`, {
    method: "POST", wallet, asset: usdmAsset, maxAmount: toUnits(String(offer.price)), onStep: input.onStep,
  });
  if (result.status !== 200) throw new Error(`Purchase failed: ${result.body?.error ?? result.receipt?.errorReason ?? `HTTP ${result.status}`}`);
  const loanAfter = loanBefore ? await api(config.apiUrl, `/loans/${loanBefore.id}`) : undefined;
  return {
    enterprise: input.enterprise,
    buyer: wallet.address,
    bundleId: bundle.id,
    reason: bundle.reason,
    price: offer.price,
    payment: result.body.payment,
    messages: result.body.bundle.messages as string[],
    loan: loanBefore && { id: loanBefore.id, before: loanBefore, after: { status: loanAfter.status, outstanding: loanAfter.outstanding } },
  };
}

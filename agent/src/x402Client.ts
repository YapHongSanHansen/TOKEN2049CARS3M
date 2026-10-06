/**
 * Server-side x402 buyer: request -> 402 offer -> sign -> retry with
 * PAYMENT-SIGNATURE -> PAYMENT-RESPONSE receipt. The same loop as the demo
 * frontend's flow.ts, without a browser. A pending settlement is re-checked with
 * the same signed payment; it is never paid twice.
 */
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { NETWORK } from "@carsem/shared";
import type { AgentWallet } from "./wallet.js";

export interface X402Step { step: "request" | "offer" | "signed" | "paid" | "pending" | "settled" | "rejected"; detail: Record<string, unknown> }

export interface PaidFetchResult<T> {
  status: number;
  body: T;
  offer?: PaymentRequirements;
  receipt?: SettleResponse;
  /** Set when `beforePay` declined; nothing was signed. */
  declined?: string;
}

export interface PaidFetchOptions {
  wallet: AgentWallet;
  asset: string;
  /** Spend cap per payment, base units. */
  maxAmount: bigint;
  method?: "GET" | "POST";
  body?: unknown;
  /** Extra request headers (e.g. the user's CARSEM key). */
  headers?: Record<string, string>;
  /** Return a reason string to stop before signing (e.g. insufficient balance). */
  beforePay?: (offer: PaymentRequirements) => Promise<string | undefined> | string | undefined;
  onStep?: (step: X402Step) => void;
  pendingChecks?: number;
  pendingDelayMs?: number;
}

async function readBody(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : undefined; } catch { return text; }
}

export async function paidFetch<T = any>(url: string, options: PaidFetchOptions): Promise<PaidFetchResult<T>> {
  const { wallet, onStep = () => {} } = options;
  const init = (headers: Record<string, string> = {}): RequestInit => ({
    method: options.method ?? "GET",
    headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers, ...headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(240_000),
  });

  const first = await fetch(url, init());
  const firstBody = await readBody(first);
  onStep({ step: "request", detail: { url, status: first.status } });
  if (first.status !== 402) return { status: first.status, body: firstBody as T };

  const http = new x402HTTPClient(x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: new ExactCardanoScheme(wallet.signer) }],
    spendControls: { allowedAssets: [{ network: NETWORK, asset: options.asset, maxAmountPerPayment: options.maxAmount.toString() }] },
    policies: [(_version, offers) => offers.filter(offer =>
      offer.asset === options.asset && BigInt(offer.amount) <= options.maxAmount &&
      (offer.extra?.assetTransferMethod ?? "default") === "default")],
  }));
  const required = http.getPaymentRequiredResponse(name => first.headers.get(name), firstBody);
  const offer = required.accepts.find(o => o.asset === options.asset);
  onStep({ step: "offer", detail: { amount: offer?.amount, asset: offer?.asset, payTo: offer?.payTo, network: offer?.network, maxTimeoutSeconds: offer?.maxTimeoutSeconds } });
  if (!offer) return { status: 402, body: firstBody as T, declined: `No offer in ${options.asset}` };
  if (BigInt(offer.amount) > options.maxAmount) return { status: 402, body: firstBody as T, offer, declined: "Price exceeds the agent's spend cap" };
  const declined = await options.beforePay?.(offer);
  if (declined) return { status: 402, body: firstBody as T, offer, declined };

  const payload = await http.createPaymentPayload(required);
  onStep({ step: "signed", detail: { nonce: payload.payload.nonce, bytes: String(payload.payload.transaction).length } });
  const headers = http.encodePaymentSignatureHeader(payload);

  const checks = options.pendingChecks ?? 8;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init(headers));
    const body = await readBody(response);
    const header = response.headers.get("PAYMENT-RESPONSE");
    const receipt = header ? decodePaymentResponseHeader(header) : undefined;
    if (receipt?.errorReason === "settlement_pending" && attempt < checks) {
      onStep({ step: "pending", detail: { attempt: attempt + 1, transaction: receipt.transaction } });
      await new Promise(resolve => setTimeout(resolve, options.pendingDelayMs ?? 10_000));
      continue;
    }
    if (receipt?.success && response.ok) {
      onStep({ step: "settled", detail: { transaction: receipt.transaction, payer: receipt.payer } });
      return { status: response.status, body: body as T, offer, receipt };
    }
    onStep({ step: "rejected", detail: { status: response.status, error: (body as { error?: string })?.error ?? receipt?.errorReason } });
    return { status: response.status, body: body as T, offer, receipt };
  }
}

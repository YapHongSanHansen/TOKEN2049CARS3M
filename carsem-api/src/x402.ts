/**
 * The x402 paywall in front of CARSEM's paid routes, built from the official
 * SDK: @x402/core's resource server, @x402/cardano's `exact` scheme and the
 * @x402/express middleware. The facilitator behind it is the Java
 * cardano-x402-facilitator on preprod, or the simulated ledger.
 *
 * Flow per paid request ("authorization" flow): verify -> route handler ->
 * settle -> response. Route handlers therefore never change state directly:
 * they return a body plus an `effect`, and the effect runs only after the
 * facilitator reports the payment settled.
 */
import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  x402HTTPResourceServer, x402ResourceServer, type HTTPRequestContext, type HTTPTransportContext, type RoutesConfig, type VerifyContext,
} from "@x402/core/server";
import type { VerifyResponse } from "@x402/core/types";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { NETWORK } from "@carsem/shared";
import type { Chain } from "./chain/index.js";
import type { Config } from "./config.js";

export interface PaidRoute {
  /** x402 route pattern, e.g. "POST /loans/:id/repay". */
  route: string;
  description: string;
  /** Price in base units of the configured tUSDM asset. */
  price(url: URL): bigint | Promise<bigint>;
}

type Effect = () => void | Promise<void>;
interface Operation {
  operation: string;
  retainUntil: number;
  payer?: string;
  verification?: { fingerprint: string; result: VerifyResponse };
  body?: unknown;
  effect?: Effect;
  effectDone?: boolean;
}

/**
 * Application idempotency, separate from the facilitator's broadcast dedup:
 * one payment buys exactly one operation, a resumed request reuses the cached
 * verification and response, and each effect runs once.
 */
class PaidOperations {
  private readonly byTx = new Map<string, Operation>();
  private readonly byOperation = new Map<string, string>();

  claim(txHash: string, operation: string, validUntil: number, payer?: string): string | undefined {
    const now = Date.now();
    for (const [id, record] of this.byTx) {
      if (record.retainUntil < now) { this.byTx.delete(id); this.byOperation.delete(record.operation); }
    }
    const prior = this.byTx.get(txHash);
    if (prior) return prior.operation === operation ? undefined : "duplicate_payment_operation";
    if (this.byOperation.has(operation)) return "duplicate_payment_operation";
    if (validUntil <= now) return "payment_expired";
    this.byTx.set(txHash, { operation, retainUntil: validUntil + 24 * 60 * 60_000, payer });
    this.byOperation.set(operation, txHash);
  }

  remember(txHash: string, fingerprint: string, result: VerifyResponse) {
    const record = this.byTx.get(txHash);
    if (record && result.isValid) record.verification = { fingerprint, result: structuredClone(result) };
  }

  verified(txHash: string, operation: string, fingerprint: string): VerifyResponse | undefined {
    const record = this.byTx.get(txHash);
    if (!record || record.operation !== operation || record.verification?.fingerprint !== fingerprint) return;
    return structuredClone(record.verification.result);
  }

  get(txHash: string) { return this.byTx.get(txHash); }

  async settled(txHash: string) {
    const record = this.byTx.get(txHash);
    if (!record?.effect || record.effectDone) return;
    record.effectDone = true;
    await record.effect();
  }
}

export interface Paywall {
  middleware: RequestHandler;
  /** The verified payment behind a paid request (only valid inside a paid route handler). */
  payment(req: Request): { txHash: string; payer?: string };
  /** Computes a paid route's response once per payment; `effect` runs after settlement. */
  respond<T>(req: Request, create: (payment: { txHash: string; payer?: string }) => { body: T; effect?: Effect }): T;
}

export async function createPaywall(config: Config, chain: Chain, paidRoutes: PaidRoute[]): Promise<Paywall> {
  const ops = new PaidOperations();
  const server = new x402ResourceServer(chain.facilitator).register(NETWORK, new ExactCardanoScheme());

  const identify = (context: VerifyContext) => {
    const request = (context.transportContext as HTTPTransportContext).request;
    const url = new URL(request.adapter.getUrl());
    const encoded = String(context.paymentPayload.payload.transaction);
    const txHash = chain.txHashOf(encoded);
    const requestId = url.searchParams.get("requestId");
    url.searchParams.delete("requestId");
    const operation = `${request.method} ${url.pathname}${url.search}:${requestId || txHash}`;
    // Bind a cached verification to the exact signed bytes and terms.
    const fingerprint = createHash("sha256").update(JSON.stringify([context.paymentPayload, context.requirements])).digest("hex");
    return { encoded, txHash, operation, fingerprint };
  };

  server.onBeforeVerify(async context => {
    try {
      const { txHash, operation, fingerprint } = identify(context);
      // A resumed request must reach settle(); fresh verification would reject a
      // payment whose inputs its own broadcast already spent.
      const result = ops.verified(txHash, operation, fingerprint);
      if (result) return { skip: true as const, result };
    } catch { /* let the scheme explain malformed payments */ }
  });
  server.onAfterVerify(async context => {
    if (!context.result.isValid) {
      console.warn(`[x402 verify] ${context.result.invalidReason ?? "invalid_payment"}${context.result.invalidMessage ? `: ${context.result.invalidMessage}` : ""}`);
      return;
    }
    try {
      const { encoded, txHash, operation, fingerprint } = identify(context);
      const reason = ops.claim(txHash, operation, chain.paymentValidUntil(encoded), context.result.payer);
      if (reason) return { abort: true as const, reason };
      ops.remember(txHash, fingerprint, context.result as VerifyResponse);
    } catch {
      return { abort: true as const, reason: "invalid_payment_operation" };
    }
  });
  server.onAfterSettle(async context => {
    if (!context.result.success) return;
    try {
      await ops.settled(chain.txHashOf(String(context.paymentPayload.payload.transaction)));
    } catch (error) {
      console.error("[x402 settle effect]", error);
    }
  });
  server.onVerifyFailure(async ({ error }) => { console.warn(`[x402 verify] ${error.message}`); });
  server.onSettleFailure(async ({ error }) => { console.warn(`[x402 settle] ${error.message}`); });
  await server.initialize();

  const routes: RoutesConfig = Object.fromEntries(paidRoutes.map(paid => [paid.route, {
    accepts: {
      scheme: "exact", network: NETWORK, payTo: chain.treasuryAddress, maxTimeoutSeconds: 600,
      price: async (context: HTTPRequestContext) => ({ amount: (await paid.price(new URL(context.adapter.getUrl()))).toString(), asset: config.usdmAsset }),
      extra: { assetTransferMethod: "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: config.l1Confirmations } },
    },
    description: paid.description,
    mimeType: "application/json",
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", description: paid.description, howToPay: "Decode the PAYMENT-REQUIRED header (x402 v2) and retry with PAYMENT-SIGNATURE." } }),
    settlementFailedResponseBody: (_context: unknown, result: { errorReason?: string }) => ({ contentType: "application/json", body: { error: result.errorReason ?? "settlement_failed" } }),
  }]));
  const http = new x402HTTPResourceServer(server, routes);
  await http.initialize();

  const payment = (req: Request) => {
    const header = req.get("PAYMENT-SIGNATURE");
    if (!header) throw new Error("No PAYMENT-SIGNATURE on a paid route");
    const txHash = chain.txHashOf(String(decodePaymentSignatureHeader(header).payload.transaction));
    return { txHash, payer: ops.get(txHash)?.payer };
  };

  return {
    middleware: paymentMiddlewareFromHTTPServer(http, undefined, undefined, false),
    payment,
    respond(req, create) {
      const paid = payment(req);
      const record = ops.get(paid.txHash);
      if (!record) throw new Error("Payment has not been verified for an operation");
      if (record.body === undefined) {
        const { body, effect } = create(paid);
        record.body = body;
        record.effect = effect;
      }
      return record.body as ReturnType<typeof create>["body"];
    },
  };
}

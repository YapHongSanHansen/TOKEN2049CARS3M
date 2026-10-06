import type { Express } from "express";
import { fromUnits } from "@carsem/shared";
import type { Context } from "../context.js";
import { HttpError } from "../services/errors.js";

const tokenOf = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{2,12}$/.test(value)) throw new HttpError(400, "token query parameter is required, e.g. ?token=MIN");
  return value.toUpperCase();
};

/** Routes that must run before the paywall (validation, so nobody pays for a 404). */
export function signalGuards(app: Express, { signals, db }: Context) {
  app.get("/signals/latest", (req, _res, next) => {
    const token = tokenOf(req.query.token);
    if (!signals.has(token)) throw new HttpError(404, `No signals for ${token}. See GET /signals/tokens.`);
    const jobId = req.query.jobId;
    if (jobId !== undefined) {
      const job = db.get<{ status: string; token: string }>("SELECT status, token FROM jobs WHERE id = ?", String(jobId));
      if (!job) throw new HttpError(404, `No job ${jobId}`);
      if (job.status !== "awaiting_payment" || job.token !== token) throw new HttpError(409, `Job ${jobId} is ${job.status} for ${job.token}`);
    }
    next();
  });
}

export function signalRoutes(app: Express, { config, signals, paywall, chain }: Context) {
  app.get("/signals/tokens", (_req, res) => {
    res.json({ price: fromUnits(config.signalPrice), asset: config.usdmAsset, tokens: signals.tokens() });
  });
  app.get("/signals/uploaders", (_req, res) => { res.json(signals.uploaders()); });

  // Paid: 402 until an x402 payment of SIGNAL_PRICE_USDM settles.
  app.get("/signals/latest", (req, res) => {
    const token = tokenOf(req.query.token);
    const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
    const body = paywall.respond(req, ({ txHash, payer }) => {
      const signal = signals.publicSignal(signals.latest(token));
      const request = { method: "GET", path: "/signals/latest", token, payer: payer ?? null, paymentTx: txHash, jobId: jobId ?? null };
      const deliveryHash = signals.deliveryHash(request, signal);
      const deliveryId = signals.newDeliveryId();
      return {
        body: {
          signal,
          delivery: {
            id: deliveryId,
            hash: deliveryHash,
            proof: "sha256(canonicalJSON({request, signal})), written on chain as label-674 metadata (decision log)",
            request,
            statusUrl: `${config.publicUrl}/signals/deliveries/${deliveryId}`,
          },
          payment: { tx: txHash, explorerUrl: chain.explorerTx(txHash), price: fromUnits(config.signalPrice), asset: config.usdmAsset },
        },
        effect: () => signals.recordDelivery({ deliveryId, signalId: signal.id, buyer: payer, paymentTx: txHash, request, deliveryHash, jobId }),
      };
    });
    res.json(body);
  });

  app.get("/signals/deliveries/:id", (req, res) => { res.json(signals.deliveryView(signals.delivery(req.params.id))); });
}

import type { Express, Request } from "express";
import { fromUnits } from "@carsem/shared";
import { userOf, type Context } from "../context.js";
import { HttpError } from "../services/errors.js";

/** The buyer: an onboarded CARSEM user, or a Masumi job (MIP-003) that pays by itself. */
function buyerOf(ctx: Context, req: Request) {
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
  if (req.get("Authorization")) {
    const user = userOf(ctx, req);
    ctx.users.requireOnboarded(user);
    return { user, jobId };
  }
  if (jobId) return { user: undefined, jobId };
  throw new HttpError(401, "Buying data needs your CARSEM key (finish onboarding first), or a Masumi job id");
}

export function dataGuards(app: Express, ctx: Context) {
  app.get("/data/listings/:id", (req, res, next) => {
    ctx.data.listing(req.params.id);
    const { jobId } = buyerOf(ctx, req);
    if (jobId) {
      const job = ctx.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", jobId);
      if (!job) throw new HttpError(404, `No job ${jobId}`);
      if (job.status !== "awaiting_payment") throw new HttpError(409, `Job ${jobId} is ${job.status}`);
    }
    next();
  });
}

export function dataRoutes(app: Express, ctx: Context) {
  const { data, paywall, chain } = ctx;

  app.get("/data/categories", (_req, res) => { res.json(data.categories()); });
  app.get("/data/search", (req, res) => {
    res.json(data.search(data.category(req.query.category), typeof req.query.q === "string" ? req.query.q : ""));
  });
  app.get("/data/uploaders", (_req, res) => { res.json(data.uploaders()); });

  // Paid: 402 until an x402 payment of the listing's price settles.
  app.get("/data/listings/:id", (req, res) => {
    const listing = data.listing(req.params.id);
    const { user, jobId } = buyerOf(ctx, req);
    const body = paywall.respond(req, ({ txHash, payer }) => {
      const view = data.publicListing(listing);
      const request = { method: "GET", path: `/data/listings/${listing.id}`, buyer: user?.did ?? payer ?? null, paymentTx: txHash, jobId: jobId ?? null };
      const deliveryHash = data.deliveryHash(request, view);
      const deliveryId = data.newDeliveryId();
      return {
        body: {
          listing: view,
          delivery: {
            id: deliveryId, hash: deliveryHash, request,
            proof: "sha256(canonicalJSON({request, listing})), logged on chain (decision log / proof of delivery)",
            statusUrl: `${ctx.config.publicUrl}/data/deliveries/${deliveryId}`,
          },
          payment: { tx: txHash, explorerUrl: chain.explorerTx(txHash), price: fromUnits(listing.price_units), asset: ctx.config.usdmAsset },
        },
        effect: () => data.recordDelivery({ deliveryId, listingId: listing.id, buyerUserId: user?.id, buyerAddress: payer, paymentTx: txHash, request, deliveryHash, jobId }),
      };
    });
    res.json(body);
  });

  app.post("/data/listings", (req, res) => {
    const user = userOf(ctx, req);
    ctx.users.requireOnboarded(user);
    res.status(201).json(data.upload(user, req.body ?? {}));
  });
  app.get("/data/deliveries/:id", (req, res) => { res.json(data.deliveryView(data.delivery(req.params.id))); });
  app.post("/data/deliveries/:id/rate", (req, res) => {
    const user = userOf(ctx, req);
    if (typeof req.body?.useful !== "boolean") throw new HttpError(400, "useful must be true or false");
    res.json(data.rate(user, req.params.id, req.body.useful));
  });
}

import type { Express } from "express";
import { fromUnits, toUnits } from "@carsem/shared";
import { userOf, type Context } from "../context.js";
import { HttpError } from "../services/errors.js";
import { wrap } from "./wrap.js";

export function lendingGuards(app: Express, { lending }: Context) {
  app.post("/loans/:id/repay", (req, _res, next) => {
    const loan = lending.get(req.params.id);
    if (loan.status !== "open") throw new HttpError(409, `Loan ${loan.id} is ${loan.status}; nothing to repay.`);
    if (lending.outstanding(loan) === 0n) throw new HttpError(409, `Loan ${loan.id} has nothing outstanding.`);
    next();
  });
}

export function lendingRoutes(app: Express, ctx: Context) {
  const { lending, paywall } = ctx;

  app.get("/loans/terms", (_req, res) => { res.json(lending.terms()); });

  // Collateral borrowing, as the user's agent. Requires the onboarding gate and synced context.
  app.post("/loans", wrap(async (req, res) => {
    const user = userOf(ctx, req);
    let amount: bigint;
    try { amount = toUnits(String(req.body?.amount ?? "")); }
    catch { throw new HttpError(400, "amount must be a decimal USDM amount, e.g. \"5\""); }
    res.status(201).json(await lending.borrow(user, amount));
  }));

  app.get("/me/loans", (req, res) => { res.json(lending.list({ userId: userOf(ctx, req).id })); });
  app.get("/loans", (req, res) => {
    res.json(lending.list({ status: typeof req.query.status === "string" ? req.query.status : undefined }));
  });
  app.get("/loans/:id", (req, res) => { res.json(lending.view(lending.get(req.params.id))); });

  // Paid: an x402 payment of the outstanding amount, to the treasury.
  app.post("/loans/:id/repay", (req, res) => {
    const loanId = req.params.id;
    const body = paywall.respond(req, ({ txHash, payer }) => {
      const outstanding = lending.outstanding(lending.get(loanId));
      return {
        body: { loanId, paid: fromUnits(outstanding), status: "repaid", collateral: "released", payment: { tx: txHash } },
        effect: () => { lending.applyPayment(loanId, outstanding, "repayment", txHash, { payer }); },
      };
    });
    res.json(body);
  });

  // Enforce deadlines now (the server also does this on a timer).
  app.post("/admin/check-defaults", (_req, res) => { res.json({ defaulted: lending.checkDefaults() }); });
}

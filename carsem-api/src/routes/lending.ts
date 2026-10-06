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

  const amountOf = (value: unknown) => {
    if (value === undefined || value === null || value === "") return undefined;
    try { return toUnits(String(value)); } catch { throw new HttpError(400, "amount must be a decimal USDM amount, e.g. \"5\""); }
  };

  // The agent asks to borrow; the user then chooses which past messages to pledge.
  app.post("/loan-requests", (req, res) => {
    const amount = amountOf(req.body?.amount);
    if (amount === undefined) throw new HttpError(400, "amount is required");
    res.status(201).json(lending.createRequest(userOf(ctx, req), amount, String(req.body?.purpose ?? "")));
  });
  app.get("/me/loan-requests", (req, res) => { res.json(lending.pendingRequests(userOf(ctx, req).id)); });
  app.get("/loan-requests/:id", (req, res) => {
    const user = userOf(ctx, req);
    const request = lending.request(req.params.id);
    if (request.user_id !== user.id) throw new HttpError(403, "Not your request");
    res.json({ ...lending.requestView(request), loan: request.loan_id ? lending.view(lending.get(request.loan_id)) : null });
  });
  app.post("/loan-requests/:id/decline", (req, res) => { res.json(lending.declineRequest(userOf(ctx, req), req.params.id)); });

  // Collateral borrowing: pledge the chosen past messages (messageIds), optionally approving a request.
  app.post("/loans", wrap(async (req, res) => {
    const user = userOf(ctx, req);
    res.status(201).json(await lending.borrow(user, {
      amount: amountOf(req.body?.amount), messageIds: req.body?.messageIds,
      requestId: typeof req.body?.requestId === "string" ? req.body.requestId : undefined,
    }));
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

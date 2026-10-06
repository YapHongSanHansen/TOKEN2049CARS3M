import type { Express } from "express";
import { fromUnits, toUnits } from "@carsem/shared";
import type { Context } from "../context.js";
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

export function lendingRoutes(app: Express, { lending, users, paywall }: Context) {
  app.get("/loans/terms", (_req, res) => { res.json(lending.terms()); });

  // Borrow. Authenticated as the agent; the agent's owner must have opted in.
  app.post("/loans", wrap(async (req, res) => {
    const agentId = String(req.body?.agentId ?? "");
    const agent = users.authenticate(agentId, req.get("Authorization"));
    let amount: bigint;
    try { amount = toUnits(String(req.body?.amount ?? "")); }
    catch { throw new HttpError(400, "amount must be a decimal tUSDM amount, e.g. \"5\""); }
    res.status(201).json(await lending.borrow(agent, amount));
  }));

  app.get("/loans", (req, res) => {
    res.json(lending.list({
      agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
      userId: typeof req.query.userId === "string" ? req.query.userId : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
    }));
  });
  app.get("/loans/:id", (req, res) => { res.json(lending.view(lending.get(req.params.id))); });

  // Paid: an x402 payment of the outstanding amount, to the treasury.
  app.post("/loans/:id/repay", (req, res) => {
    const loanId = req.params.id;
    const body = paywall.respond(req, ({ txHash, payer }) => {
      const loan = lending.get(loanId);
      const outstanding = lending.outstanding(loan);
      return {
        body: {
          loanId,
          paid: fromUnits(outstanding),
          status: "repaid",
          collateral: "released",
          payment: { tx: txHash },
        },
        effect: () => { lending.applyPayment(loanId, outstanding, "repayment", txHash, { payer }); },
      };
    });
    res.json(body);
  });

  // Enforce deadlines now (the server also does this on a timer).
  app.post("/admin/check-defaults", (_req, res) => { res.json({ defaulted: lending.checkDefaults() }); });
}

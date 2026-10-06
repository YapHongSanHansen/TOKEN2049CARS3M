/**
 * Masumi Agentic Service API (MIP-003) surface, so CARSEM can be registered on
 * the Masumi registry: /availability, /input_schema, /start_job, /status.
 * A job is paid over x402 at the URL /start_job returns; delivery completes it
 * and its result hash is the delivery hash logged on chain.
 */
import type { Express } from "express";
import { fromUnits } from "@carsem/shared";
import type { Context } from "../context.js";
import { HttpError, newId } from "../services/errors.js";

export function masumiRoutes(app: Express, { config, db, signals }: Context) {
  app.get("/availability", (_req, res) => {
    res.json({ status: "available", type: "masumi-agent", message: "CARSEM trading-signal service is online" });
  });

  app.get("/input_schema", (_req, res) => {
    res.json({ input_data: [{ id: "token", type: "string", name: "Token", data: { description: "Token symbol to get a trading signal for", placeholder: "MIN" } }] });
  });

  app.post("/start_job", (req, res) => {
    const fromList = Array.isArray(req.body?.input_data) ? req.body.input_data.find((i: { key?: string }) => i?.key === "token")?.value : undefined;
    const token = String(fromList ?? req.body?.input_data?.token ?? req.body?.token ?? "").toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(token)) throw new HttpError(400, "input_data must include token");
    if (!signals.has(token)) throw new HttpError(404, `No signals for ${token}`);
    const jobId = newId("job");
    db.run("INSERT INTO jobs (id, token, status, created_at) VALUES (?, ?, 'awaiting_payment', ?)", jobId, token, Date.now());
    res.status(201).json({
      status: "success",
      job_id: jobId,
      payment: { protocol: "x402", method: "GET", url: `${config.publicUrl}/signals/latest?token=${token}&jobId=${jobId}`, price: fromUnits(config.signalPrice), asset: config.usdmAsset },
    });
  });

  app.get("/status", (req, res) => {
    const jobId = String(req.query.job_id ?? "");
    const job = db.get<{ id: string; token: string; status: string; delivery_id: string | null }>("SELECT * FROM jobs WHERE id = ?", jobId);
    if (!job) throw new HttpError(404, `No job ${jobId}`);
    const delivery = job.delivery_id ? signals.deliveryView(signals.delivery(job.delivery_id)) : undefined;
    res.json({
      job_id: job.id,
      status: job.status,
      ...(delivery ? { result_hash: delivery.deliveryHash, decision_log: delivery.decisionLog, delivery: delivery.id } : {}),
    });
  });
}

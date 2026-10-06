/**
 * Masumi Agentic Service API (MIP-003), so CARSEM can be registered on the
 * Masumi registry: /availability, /input_schema, /start_job, /status.
 * A job is paid over x402 at the URL /start_job returns; delivery completes it,
 * and its result hash is the delivery hash logged on chain.
 */
import type { Express } from "express";
import type { Context } from "../context.js";
import { HttpError, newId } from "../services/errors.js";

export function masumiRoutes(app: Express, { config, db, data }: Context) {
  app.get("/availability", (_req, res) => {
    res.json({ status: "available", type: "masumi-agent", message: "CARSEM data platform: trading signals and live flight / hotel / product prices" });
  });

  app.get("/input_schema", (_req, res) => {
    res.json({
      input_data: [
        { id: "category", type: "option", name: "Category", data: { values: ["signal", "flight", "hotel", "product"] } },
        { id: "query", type: "string", name: "Query", data: { description: "Token (MIN), route (KUL-SIN), city (SINGAPORE) or product name", placeholder: "MIN" } },
      ],
    });
  });

  app.post("/start_job", (req, res) => {
    const list = Array.isArray(req.body?.input_data) ? req.body.input_data as Array<{ key?: string; value?: unknown }> : [];
    const input = (key: string) => list.find(i => i?.key === key)?.value ?? req.body?.input_data?.[key] ?? req.body?.[key];
    const category = data.category(input("category") ?? "signal");
    const query = String(input("query") ?? input("token") ?? "");
    const [best] = data.search(category, query, 1);
    if (!best) throw new HttpError(404, `No ${category} data for "${query}"`);
    const jobId = newId("job");
    db.run("INSERT INTO jobs (id, category, subject, status, created_at) VALUES (?, ?, ?, 'awaiting_payment', ?)", jobId, category, best.subject, Date.now());
    res.status(201).json({
      status: "success",
      job_id: jobId,
      payment: { protocol: "x402", method: "GET", url: `${config.publicUrl}/data/listings/${best.id}?jobId=${jobId}`, price: best.price, asset: config.usdmAsset },
    });
  });

  app.get("/status", (req, res) => {
    const jobId = String(req.query.job_id ?? "");
    const job = db.get<{ id: string; status: string; delivery_id: string | null }>("SELECT * FROM jobs WHERE id = ?", jobId);
    if (!job) throw new HttpError(404, `No job ${jobId}`);
    const delivery = job.delivery_id ? data.deliveryView(data.delivery(job.delivery_id)) : undefined;
    res.json({
      job_id: job.id,
      status: job.status,
      ...(delivery ? { result_hash: delivery.deliveryHash, decision_log: delivery.decisionLog, delivery: delivery.id } : {}),
    });
  });
}

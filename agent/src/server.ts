/**
 * The agent as an HTTP service, for the chat UI:
 *   POST /runs { message, brain?, forceOutcome? }  -> { id }
 *   GET  /runs/:id                                 -> run with all events so far
 *   GET  /runs/:id/events                          -> Server-Sent Events stream
 *   GET  /wallet                                   -> address and balances
 *   GET  /enterprises, POST /enterprises/:name/buy -> demo data buyers (x402)
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { LOVELACE, fromUnits } from "@carsem/shared";
import { api } from "./api.js";
import { runAgent, type Brain } from "./brain.js";
import { buyBundle, enterpriseBalance } from "./buyers.js";
import type { X402Step } from "./x402Client.js";
import { loadAgentConfig } from "./config.js";
import { printEvent } from "./log.js";
import type { AgentEvent } from "./tools.js";
import { agentWallet } from "./wallet.js";

interface Run { id: string; status: "running" | "finished" | "failed"; message: string; events: Array<AgentEvent & { at: string }>; summary?: string; listeners: Set<(event: (AgentEvent & { at: string }) | null) => void> }

const config = loadAgentConfig();
const wallet = agentWallet(config);
const runs = new Map<string, Run>();
let busy = false;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

app.get("/wallet", async (_req, res, next) => {
  try {
    const health = await api<{ usdmAsset: string }>(config.apiUrl, "/health");
    const balances = await wallet.balances();
    res.json({ agentId: config.agentId, address: wallet.address, mode: config.mode, tUSDM: fromUnits(balances[health.usdmAsset] ?? 0n), tADA: fromUnits(balances[LOVELACE] ?? 0n) });
  } catch (error) { next(error); }
});

app.post("/runs", (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) { res.status(400).json({ error: "message is required" }); return; }
  // One wallet, one run at a time: concurrent runs would race for the same UTxOs and loan slot.
  if (busy) { res.status(409).json({ error: "The agent is already running a task" }); return; }
  const brain = req.body?.brain as Brain | undefined;
  const forceOutcome = req.body?.forceOutcome as "win" | "loss" | undefined;
  const run: Run = { id: randomUUID(), status: "running", message, events: [], listeners: new Set() };
  runs.set(run.id, run);
  busy = true;
  const emit = (event: AgentEvent) => {
    const stamped = { ...event, at: new Date().toISOString() };
    run.events.push(stamped);
    printEvent(event);
    for (const listener of run.listeners) listener(stamped);
  };
  runAgent(message, { config, wallet, emit, brain, forceOutcome })
    .then(result => { run.status = "finished"; run.summary = result.summary; })
    .catch(() => { run.status = "failed"; })
    .finally(() => { busy = false; for (const listener of run.listeners) listener(null); });
  res.status(202).json({ id: run.id });
});

app.get("/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) { res.status(404).json({ error: "No such run" }); return; }
  const { listeners: _listeners, ...view } = run;
  res.json(view);
});

app.get("/runs/:id/events", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) { res.status(404).json({ error: "No such run" }); return; }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: AgentEvent & { at: string }) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  run.events.forEach(send);
  if (run.status !== "running") { res.end(); return; }
  // null marks the end of the run.
  const listener = (event: (AgentEvent & { at: string }) | null) => { if (event) send(event); else res.end(); };
  run.listeners.add(listener);
  req.on("close", () => run.listeners.delete(listener));
});

app.get("/runs", (_req, res) => {
  res.json([...runs.values()].reverse().slice(0, 20).map(({ listeners: _listeners, events, ...run }) => ({ ...run, events: events.length })));
});

// Enterprise buyers (demo): each has its own wallet and pays over x402.
app.get("/enterprises", async (_req, res, next) => {
  try { res.json(await Promise.all(["eBay", "Amazon", "BNB", "Meta"].map(name => enterpriseBalance(config, name)))); }
  catch (error) { next(error); }
});
app.post("/enterprises/:name/buy", async (req, res) => {
  const steps: X402Step[] = [];
  try {
    const result = await buyBundle(config, { enterprise: req.params.name, bundleId: req.body?.bundleId, onStep: step => steps.push(step) });
    res.json({ ...result, steps });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message, steps });
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
});

app.listen(config.port, () => console.log(`agent ${config.agentId} on http://localhost:${config.port}  wallet ${wallet.address} (${config.mode}, brain ${config.anthropicConfigured ? "claude" : "scripted"})`));

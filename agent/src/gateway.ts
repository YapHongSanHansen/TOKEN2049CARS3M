/**
 * The CARSEM agent gateway: where every AI app meets CARSEM.
 *
 *   POST /mcp                 MCP (Streamable HTTP), Authorization: Bearer csm_…
 *   POST /mcp/k/:key          the same, with the key in a personal URL (ChatGPT / Claude connectors)
 *   GET  /v1/tools            tool list           POST /v1/tools/:name   run one tool (curl)
 *   POST /v1/ask              plain English → the built-in brain (streams progress to curl)
 *   GET  /v1/activity         this user's agent activity (dashboard)
 *   POST /internal/wallets    carsem-api only: create the user's hosted wallet
 *   GET  /enterprises, POST /enterprises/:name/buy   demo data buyers
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { api, ApiError } from "./api.js";
import { runAgent, type Brain } from "./brain.js";
import { buyBundle, enterpriseBalance } from "./buyers.js";
import type { GatewayConfig } from "./config.js";
import { Custody } from "./custody.js";
import { formatEvent } from "./log.js";
import { handleMcp } from "./mcp.js";
import { findTool, TOOLS } from "./toolDefs.js";
import { UserAgent, type AgentEvent } from "./tools.js";
import type { X402Step } from "./x402Client.js";
import { z } from "zod";

interface Profile { id: string; name: string; onboarded: boolean; connect: { onboarding: string } }

export function createGateway(config: GatewayConfig, custody = new Custody(config)) {
  const profiles = new Map<string, { profile: Profile; at: number }>();
  const running = new Set<string>();

  async function resolve(key: string | undefined): Promise<{ key: string; profile: Profile }> {
    const clean = key?.replace(/^Bearer\s+/i, "").trim();
    if (!clean) throw new ApiError(401, "Missing CARSEM key. Onboard first, then use Authorization: Bearer csm_…");
    const cached = profiles.get(clean);
    if (cached && Date.now() - cached.at < 10_000 && cached.profile.onboarded) return { key: clean, profile: cached.profile };
    const profile = await api<Profile>(config.apiUrl, "/me", { headers: { Authorization: `Bearer ${clean}` } });
    profiles.set(clean, { profile, at: Date.now() });
    return { key: clean, profile };
  }

  function agentFor(key: string, profile: Profile, extraEmit?: (event: AgentEvent) => void, forceOutcome?: "win" | "loss", log = true) {
    const emit = (event: AgentEvent) => {
      if (log) custody.log(profile.id, event.type, event, "tool" in event ? event.tool : undefined);
      extraEmit?.(event);
    };
    return new UserAgent(config, key, profile.onboarded ? custody.wallet(profile.id) : undefined, emit, forceOutcome);
  }

  const app = express();
  app.use(express.json({ limit: "512kb" }));
  app.use((req, res, next) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Expose-Headers": "Mcp-Session-Id" });
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });
  const wrap = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };

  app.get("/", (_req, res) => {
    res.type("text/plain").send(`CARSEM agent gateway (${config.mode})

Onboard first (Masumi DID: KYC + consent) to get your CARSEM key, then:

  curl -N ${config.publicUrl}/v1/ask -H "Authorization: Bearer $CARSEM_KEY" -H "Content-Type: application/json" \\
       -d '{"message":"Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades"}'

  curl ${config.publicUrl}/v1/tools                      # list tools
  curl ${config.publicUrl}/v1/tools/search_data -H "Authorization: Bearer $CARSEM_KEY" -H "Content-Type: application/json" -d '{"category":"flight","query":"KUL-SIN"}'

MCP (Hermes, Claude Code, ChatGPT, Claude): ${config.publicUrl}/mcp   or   ${config.publicUrl}/mcp/k/<your key>
`);
  });
  app.get("/health", (_req, res) => { res.json({ status: "ok", mode: config.mode, brain: config.openai.apiKey ? "openai" : "scripted", mcp: `${config.publicUrl}/mcp` }); });

  // carsem-api → gateway: the user's one hosted wallet.
  app.post("/internal/wallets", (req, res) => {
    if (req.get("X-Service-Token") !== config.serviceToken) { res.status(401).json({ error: "bad service token" }); return; }
    const userId = String(req.body?.userId ?? "");
    if (!/^usr_[0-9a-z_]+$/.test(userId)) { res.status(400).json({ error: "userId required" }); return; }
    res.json(custody.create(userId));
  });

  // MCP.
  const mcp = (keyFrom: (req: Request) => string | undefined) => wrap(async (req, res) => {
    let who;
    try { who = await resolve(keyFrom(req)); }
    catch (error) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: (error as Error).message }, id: null });
      return;
    }
    await handleMcp(req, res, agentFor(who.key, who.profile));
  });
  app.all("/mcp", mcp(req => req.get("Authorization")));
  app.all("/mcp/k/:key", mcp(req => req.params.key));

  // curl: tools.
  app.get("/v1/tools", (_req, res) => {
    res.json(TOOLS.map(t => {
      const { $schema: _schema, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
      return { name: t.name, title: t.title, description: t.description, input_schema: schema, url: `${config.publicUrl}/v1/tools/${t.name}` };
    }));
  });
  app.post("/v1/tools/:name", wrap(async (req, res) => {
    const tool = findTool(req.params.name);
    if (!tool) { res.status(404).json({ error: `No tool ${req.params.name}` }); return; }
    const who = await resolve(req.get("Authorization"));
    const parsed = tool.input.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "Invalid input", issues: parsed.error.issues }); return; }
    res.json(await tool.run(agentFor(who.key, who.profile, undefined, req.body?.forceOutcome), parsed.data));
  }));

  // curl: plain English. Streams progress lines (curl -N); ?format=json returns one JSON object.
  app.post("/v1/ask", wrap(async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) { res.status(400).json({ error: "message is required" }); return; }
    const who = await resolve(req.get("Authorization"));
    if (running.has(who.profile.id)) { res.status(409).json({ error: "Your agent is already working on a task" }); return; }
    running.add(who.profile.id);
    const json = req.query.format === "json";
    const events: AgentEvent[] = [];
    if (!json) res.type("text/plain").set("Cache-Control", "no-cache");
    const emit = (event: AgentEvent) => { events.push(event); const line = formatEvent(event); if (!json && line) res.write(`${line}\n`); };
    try {
      const result = await runAgent(message, {
        agent: agentFor(who.key, who.profile, emit, req.body?.forceOutcome),
        config, emit, brain: req.body?.brain as Brain | undefined,
      });
      if (json) res.json({ ...result, events }); else res.end();
    } catch (error) {
      if (json) res.status(500).json({ error: (error as Error).message, events }); else res.end(`✖ ${(error as Error).message}\n`);
    } finally {
      running.delete(who.profile.id);
    }
  }));

  app.get("/v1/activity", wrap(async (req, res) => {
    const who = await resolve(req.get("Authorization"));
    res.json(custody.activity(who.profile.id, Number(req.query.after ?? 0)));
  }));
  app.get("/v1/me", wrap(async (req, res) => {
    const who = await resolve(req.get("Authorization"));
    // The dashboard polls this; it is not agent activity, so it is not logged.
    res.json(await agentFor(who.key, who.profile, undefined, undefined, false).status());
  }));

  // Demo enterprise buyers (each has its own wallet and pays over x402).
  app.get("/enterprises", wrap(async (_req, res) => {
    res.json(await Promise.all(["eBay", "Amazon", "BNB", "Meta"].map(name => enterpriseBalance(config, name))));
  }));
  app.post("/enterprises/:name/buy", wrap(async (req, res) => {
    const steps: X402Step[] = [];
    try { res.json({ ...(await buyBundle(config, { enterprise: req.params.name, bundleId: req.body?.bundleId, onStep: step => steps.push(step) })), steps }); }
    catch (error) { res.status(409).json({ error: (error as Error).message, steps }); }
  }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const status = error instanceof ApiError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message.replace(/^[A-Z]+ \S+: /, "") : "Internal error" });
  });

  return { app, custody };
}

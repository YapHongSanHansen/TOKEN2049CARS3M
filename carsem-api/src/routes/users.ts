import type { Express } from "express";
import { fromUnits } from "@carsem/shared";
import type { Context } from "../context.js";
import { HttpError } from "../services/errors.js";

export function userRoutes(app: Express, { users, chain }: Context) {
  app.post("/users", (req, res) => { res.status(201).json(users.create(String(req.body?.name ?? ""), req.body?.id)); });

  app.get("/users/:id", (req, res) => {
    const user = users.get(req.params.id);
    res.json({ id: user.id, name: user.name, earnings: fromUnits(user.earnings_units), consent: users.consent(user.id) });
  });

  // Before/after redaction, nothing stored. For the opt-in screen.
  app.post("/redact/preview", (req, res) => {
    const chats = req.body?.chats;
    if (!Array.isArray(chats) || !chats.every(c => typeof c === "string")) throw new HttpError(400, "chats must be an array of strings");
    res.json(users.preview(chats));
  });

  // Opt in: "Allow my agent to borrow against my redacted chat data".
  app.post("/users/:id/consent", (req, res) => {
    res.status(201).json(users.grantConsent(req.params.id, {
      chats: req.body?.chats, agentId: req.body?.agentId, allowSaleWhileOpen: req.body?.allowSaleWhileOpen,
    }));
  });
  app.get("/users/:id/consent", (req, res) => { res.json(users.consent(req.params.id)); });
  app.delete("/users/:id/consent", (req, res) => { res.json(users.revokeConsent(req.params.id)); });

  // Register an agent the user owns. The API key is returned once.
  app.post("/users/:id/agents", (req, res) => {
    res.status(201).json(users.registerAgent(req.params.id, {
      id: req.body?.id, name: req.body?.name, address: req.body?.address, masumiAgentId: req.body?.masumiAgentId, currentKey: req.body?.currentKey,
    }));
  });
  app.get("/agents/:id", (req, res) => {
    const agent = users.agentView(users.agent(req.params.id));
    res.json({ ...agent, explorerUrl: chain.explorerAddress(agent.address) });
  });
}

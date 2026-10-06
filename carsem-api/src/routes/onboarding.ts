import type { Express } from "express";
import { fromUnits, redactChats, displayLine } from "@carsem/shared";
import { userOf, type Context } from "../context.js";
import { HttpError } from "../services/errors.js";
import { SYNC_SOURCES } from "../services/users.js";
import { wrap } from "./wrap.js";

/** Onboarding gate, identity documents and data sync. */
export function onboardingRoutes(app: Express, ctx: Context) {
  const { config, users, issuer, sync, db } = ctx;

  app.get("/onboarding/config", (_req, res) => {
    res.json({
      kycProvider: "mock",
      issuer: issuer.did,
      consentText: "Allow my agent to borrow against my redacted chats. If my agent does not repay by the deadline, my redacted chats are published on CARSEM and sold to any user for a fee.",
      sources: SYNC_SOURCES,
      minMessagesToPledge: config.minPledgeItems,
      gateway: config.gatewayPublicUrl,
    });
  });

  // 0. Open an account. The key is shown once.
  app.post("/onboarding/start", (req, res) => {
    const { user, apiKey } = users.start(String(req.body?.name ?? ""));
    res.status(201).json({ apiKey, profile: users.profile(user) });
  });

  app.get("/me", (req, res) => { res.json(users.profile(userOf(ctx, req))); });

  // 1. KYC.
  app.post("/onboarding/kyc", (req, res) => { res.json(users.kyc(userOf(ctx, req), req.body ?? {})); });

  // 2. Consent (required to continue). 3. Complete: agent + wallet + DID + credential.
  app.post("/onboarding/consent", (req, res) => { res.json(users.grantConsent(userOf(ctx, req), req.body ?? {})); });
  app.delete("/me/consent", (req, res) => { res.json(users.revokeConsent(userOf(ctx, req))); });
  app.post("/onboarding/complete", wrap(async (req, res) => { res.json(await users.complete(userOf(ctx, req))); }));

  // Identity documents (did:web resolution) and credential checks.
  app.get("/.well-known/did.json", (_req, res) => { res.json(issuer.didDocument()); });
  app.get("/users/:id/did.json", (req, res) => {
    const user = users.get(req.params.id);
    if (!user.did) throw new HttpError(404, "This user has no DID yet");
    res.json(issuer.userDidDocument(user.id, users.agentOf(user.id)?.did));
  });
  app.get("/credentials/status/:userId", (req, res) => {
    const user = users.get(req.params.userId);
    res.json({ userId: user.id, did: user.did, kyc: user.kyc_status, revoked: user.vc_revoked === 1, issuer: issuer.did });
  });
  app.post("/credentials/verify", (req, res) => {
    const credential = issuer.verifyJwt(String(req.body?.jwt ?? "")) as { credentialSubject: { id: string } };
    const userId = credential.credentialSubject.id.split(":").at(-1)!;
    const row = db.get<{ vc_revoked: number }>("SELECT vc_revoked FROM users WHERE id = ?", userId);
    res.json({ valid: !!row && row.vc_revoked === 0, revoked: row?.vc_revoked === 1, credential });
  });

  // Your past messages: redacted on arrival, raw text never stored. You pledge some of them when your agent borrows.
  app.post("/me/sync", (req, res) => {
    const user = userOf(ctx, req);
    users.requireOnboarded(user);
    res.json(sync.add(user, String(req.body?.source ?? "assistant"), req.body?.items));
  });
  app.get("/me/messages", (req, res) => {
    const user = userOf(ctx, req);
    res.json({ ...sync.stats(user.id), messages: sync.messages(user.id) });
  });
  app.post("/me/messages/import", (req, res) => {
    const user = userOf(ctx, req);
    users.requireOnboarded(user);
    res.json(sync.import(user, req.body?.format, req.body?.content));
  });
  app.post("/me/messages/sample", (req, res) => {
    const user = userOf(ctx, req);
    users.requireOnboarded(user);
    res.json(sync.addSample(user));
  });
  app.get("/me/earnings", (req, res) => { res.json({ earnings: fromUnits(userOf(ctx, req).earnings_units) }); });

  // Before/after redaction, nothing stored.
  app.post("/redact/preview", (req, res) => {
    const chats = req.body?.chats;
    if (!Array.isArray(chats) || !chats.every(c => typeof c === "string")) throw new HttpError(400, "chats must be an array of strings");
    const bundle = redactChats(chats);
    res.json({ before: chats, after: bundle.messages.map(displayLine), stats: bundle.stats });
  });
}

/**
 * Accounts and onboarding: the gate every AI app passes through before using CARSEM.
 *
 *   start      → an account and its API key (works only for onboarding until the gate is passed)
 *   KYC        → mock KYC (demo); one identity document = one account
 *   consent    → "allow my agent to borrow against my redacted chats" (required to continue)
 *   complete   → the user's ONE agent + hosted wallet (via the gateway), starter funds,
 *                a user DID and a signed "KYC verified" credential
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { LOVELACE, fromUnits } from "@carsem/shared";
import type { Chain } from "../chain/index.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { GatewayClient } from "./gateway.js";
import type { Issuer } from "./identity.js";
import { mockKyc, type KycOutcome } from "./kyc.js";

export interface UserRow {
  id: string; name: string; api_key_hash: string; did: string | null;
  kyc_status: "none" | "pending" | "verified" | "rejected"; kyc_provider: string | null; kyc_ref: string | null;
  kyc_subject_hash: string | null; kyc_at: number | null; vc_jwt: string | null; vc_revoked: number;
  earnings_units: string; onboarded_at: number | null; created_at: number;
}
export interface AgentRow { id: string; user_id: string; name: string; address: string; did: string; masumi_agent_id: string | null; created_at: number }
export interface ConsentRow { user_id: string; status: "active" | "revoked"; allow_borrowing: number; allow_sale_while_open: number; sources_json: string; granted_at: number; revoked_at: number | null }

export const SYNC_SOURCES = ["assistant", "export", "hermes", "claude_code", "tool_queries"] as const;
const keyHash = (key: string) => createHash("sha256").update(`carsem-user-key:${key}`).digest("hex");

export class Users {
  constructor(
    private readonly db: Db, private readonly config: Config, private readonly issuer: Issuer,
    private readonly chain: Chain, private readonly gateway: GatewayClient,
  ) {}

  get onboardingUrl() { return `${this.config.frontendUrl}/#start`; }

  /** Opens an account. The key is returned once; only its hash is stored. */
  start(name: string, options: { id?: string; apiKey?: string } = {}) {
    if (!name?.trim()) throw new HttpError(400, "name is required");
    const apiKey = options.apiKey ?? `csm_${randomBytes(24).toString("base64url")}`;
    const id = options.id ?? newId("usr");
    this.db.run("INSERT INTO users (id, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)", id, name.trim().slice(0, 80), keyHash(apiKey), Date.now());
    return { user: this.get(id), apiKey };
  }

  get(id: string): UserRow {
    const user = this.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    if (!user) throw new HttpError(404, `No user ${id}`);
    return user;
  }

  /** `Authorization: Bearer <key>` (or the raw key). */
  authenticate(authorization: string | undefined): UserRow {
    const key = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!key) throw new HttpError(401, "Missing CARSEM key (Authorization: Bearer csm_…). Get one at the onboarding page.");
    const hash = keyHash(key);
    const user = this.db.get<UserRow>("SELECT * FROM users WHERE api_key_hash = ?", hash);
    if (!user || !timingSafeEqual(Buffer.from(user.api_key_hash, "hex"), Buffer.from(hash, "hex"))) throw new HttpError(401, "Unknown CARSEM key");
    return user;
  }

  agentOf(userId: string) { return this.db.get<AgentRow>("SELECT * FROM agents WHERE user_id = ?", userId); }
  agentByAddress(address: string) { return this.db.get<AgentRow>("SELECT * FROM agents WHERE address = ?", address); }
  consentOf(userId: string) { return this.db.get<ConsentRow>("SELECT * FROM consents WHERE user_id = ?", userId); }

  /** The gate: KYC-verified, credential valid, consent active, agent created. */
  requireOnboarded(user: UserRow): AgentRow {
    const agent = this.agentOf(user.id);
    if (!user.onboarded_at || !agent) {
      throw new HttpError(403, `Finish onboarding first (Masumi DID + KYC + consent): ${this.onboardingUrl}`, "onboarding_required");
    }
    if (user.kyc_status !== "verified" || user.vc_revoked) throw new HttpError(403, "Your KYC credential is not valid", "kyc_required");
    if (this.consentOf(user.id)?.status !== "active") throw new HttpError(403, "You revoked consent; re-enable it on the onboarding page to continue", "consent_required");
    return agent;
  }

  // ---- KYC ------------------------------------------------------------------

  kyc(user: UserRow, input: Record<string, unknown>) {
    return this.applyKyc(user, mockKyc(input), "mock");
  }

  private applyKyc(user: UserRow, outcome: KycOutcome, provider: string) {
    if (outcome.status !== "verified") {
      this.db.run("UPDATE users SET kyc_status = ?, kyc_provider = ?, kyc_ref = ? WHERE id = ?", outcome.status, provider, outcome.ref ?? null, user.id);
      return { status: outcome.status, detail: outcome.detail };
    }
    const other = this.db.get<{ id: string }>("SELECT id FROM users WHERE kyc_subject_hash = ? AND id != ?", outcome.subjectHash, user.id);
    if (other) throw new HttpError(409, "This identity already has a CARSEM account. One person gets one account and one platform wallet.", "duplicate_identity");
    this.db.run("UPDATE users SET kyc_status = 'verified', kyc_provider = ?, kyc_ref = ?, kyc_subject_hash = ?, kyc_at = ? WHERE id = ?",
      provider, outcome.ref, outcome.subjectHash, Date.now(), user.id);
    return { status: "verified" as const };
  }

  // ---- consent --------------------------------------------------------------

  grantConsent(user: UserRow, input: { allowBorrowing?: unknown; allowSaleWhileOpen?: unknown; sources?: unknown }) {
    if (user.kyc_status !== "verified") throw new HttpError(403, "Verify your identity (KYC) before giving consent", "kyc_required");
    if (input.allowBorrowing !== true) throw new HttpError(400, "CARSEM can only continue with your consent to borrow against your redacted chats (allowBorrowing: true)");
    const sources = Array.isArray(input.sources) ? input.sources.filter((s): s is string => (SYNC_SOURCES as readonly string[]).includes(String(s))) : [...SYNC_SOURCES];
    this.db.run(`INSERT INTO consents (user_id, status, allow_borrowing, allow_sale_while_open, sources_json, granted_at) VALUES (?, 'active', 1, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET status = 'active', allow_borrowing = 1, allow_sale_while_open = excluded.allow_sale_while_open,
      sources_json = excluded.sources_json, granted_at = excluded.granted_at, revoked_at = NULL`,
      user.id, input.allowSaleWhileOpen === false ? 0 : 1, JSON.stringify(sources), Date.now());
    return this.consentView(user.id);
  }

  revokeConsent(user: UserRow) {
    if (this.db.get("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('disbursing','open')", user.id)) {
      throw new HttpError(409, "Consent cannot be revoked while a loan holds your chats as collateral. Repay first.");
    }
    this.db.run("UPDATE consents SET status = 'revoked', revoked_at = ? WHERE user_id = ?", Date.now(), user.id);
    return this.consentView(user.id);
  }

  consentView(userId: string) {
    const c = this.consentOf(userId);
    if (!c) return { status: "none" as const };
    return {
      status: c.status, allowBorrowing: c.allow_borrowing === 1, allowSaleWhileOpen: c.allow_sale_while_open === 1,
      sources: JSON.parse(c.sources_json) as string[], grantedAt: new Date(c.granted_at).toISOString(), revokedAt: c.revoked_at && new Date(c.revoked_at).toISOString(),
    };
  }

  // ---- completion -----------------------------------------------------------

  /** Creates the user's one agent + wallet, funds it, and issues the DID + KYC credential. Idempotent. */
  complete(user: UserRow) {
    // Concurrent calls (double clicks, retries) share one run: one agent, one wallet, one funding.
    let running = this.completing.get(user.id);
    if (!running) {
      running = this.doComplete(user).finally(() => this.completing.delete(user.id));
      this.completing.set(user.id, running);
    }
    return running;
  }

  private readonly completing = new Map<string, ReturnType<Users["doComplete"]>>();

  private async doComplete(user: UserRow) {
    if (user.kyc_status !== "verified") throw new HttpError(403, "KYC is not verified yet", "kyc_required");
    if (this.consentOf(user.id)?.status !== "active") throw new HttpError(403, "Give consent first", "consent_required");
    let agent = this.agentOf(user.id);
    if (!agent) {
      const { address } = await this.gateway.createWallet(user.id);
      const agentId = newId("agt");
      this.db.run("INSERT INTO agents (id, user_id, name, address, did, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        agentId, user.id, `${user.name}'s agent`, address, this.issuer.agentDid(agentId), Date.now());
      agent = this.agentOf(user.id)!;
      // Starter funds: tADA for fees and the 0.05 USDM that is not enough for a 5 USDM paywall.
      await this.chain.sendAssets("treasury", address, { [LOVELACE]: this.config.starter.ada, [this.config.usdmAsset]: this.config.starter.usdm },
        { msg: ["CARSEM starter funds", agent.id] });
    }
    if (!user.onboarded_at || !user.vc_jwt) {
      const did = this.issuer.userDid(user.id);
      const { jwt } = this.issuer.issueKycCredential({
        userId: user.id, userDid: did, agentDid: agent.did, walletAddress: agent.address,
        provider: "mock", level: "demo-basic", verifiedAt: user.kyc_at ?? Date.now(),
      });
      this.db.run("UPDATE users SET did = ?, vc_jwt = ?, vc_revoked = 0, onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?", did, jwt, Date.now(), user.id);
    }
    return this.profile(this.get(user.id));
  }

  /** Everything the user (or their AI) needs to know about their account. */
  profile(user: UserRow) {
    const agent = this.agentOf(user.id);
    return {
      id: user.id,
      name: user.name,
      onboarded: !!user.onboarded_at,
      steps: { kyc: user.kyc_status, consent: this.consentOf(user.id)?.status ?? "none", agent: !!agent },
      kyc: { status: user.kyc_status, provider: "mock (demo)", verifiedAt: user.kyc_at && new Date(user.kyc_at).toISOString() },
      identity: user.did ? {
        did: user.did,
        didDocument: `${this.config.publicUrl}/users/${user.id}/did.json`,
        credential: { jwt: user.vc_jwt, revoked: user.vc_revoked === 1, issuer: this.issuer.did },
      } : null,
      agent: agent && {
        id: agent.id, name: agent.name, did: agent.did, address: agent.address,
        masumi: agent.masumi_agent_id ? { registered: true, agentIdentifier: agent.masumi_agent_id } : { registered: false, note: "Registered on the Masumi registry when CARSEM runs on preprod with a public URL" },
        explorerUrl: this.chain.explorerAddress(agent.address),
      },
      consent: this.consentView(user.id),
      earnings: fromUnits(user.earnings_units),
      connect: { gateway: this.config.gatewayPublicUrl, mcp: `${this.config.gatewayPublicUrl}/mcp`, onboarding: this.onboardingUrl },
    };
  }
}

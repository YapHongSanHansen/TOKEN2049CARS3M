import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Hex } from "@carsem/shared";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import { displayLine, redactChats, type RedactedBundle } from "./redaction.js";
import { open, seal } from "./vault.js";

export interface UserRow { id: string; name: string; earnings_units: string; created_at: number }
export interface AgentRow { id: string; name: string; owner_user_id: string; address: string; did: string; masumi_agent_id: string | null; key_hash: string; created_at: number }
export interface BundleRow { id: string; user_id: string; collateral_ref: string; ciphertext: string; iv: string; tag: string; preview_json: string; stats_json: string; status: string; created_at: number }
export interface ConsentRow { user_id: string; agent_id: string | null; status: string; bundle_id: string | null; allow_sale_while_open: number; granted_at: number; revoked_at: number | null }

const keyHash = (key: string) => createHash("sha256").update(`carsem-agent-key:${key}`).digest("hex");

export class Users {
  constructor(private readonly db: Db, private readonly config: Config) {}

  create(name: string, id = newId("usr")): UserRow {
    if (!name?.trim()) throw new HttpError(400, "name is required");
    this.db.run("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING", id, name.trim(), Date.now());
    return this.get(id);
  }

  get(id: string): UserRow {
    const user = this.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    if (!user) throw new HttpError(404, `No user ${id}`);
    return user;
  }

  /** Redaction preview without storing anything. */
  preview(chats: string[]) {
    const bundle = redactChats(chats);
    return { before: chats, after: bundle.messages.map(displayLine), stats: bundle.stats };
  }

  /**
   * Opt-in: redact the chats, keep only the encrypted redacted bundle, and let
   * `agentId` borrow against it. Raw chats are discarded after redaction.
   */
  grantConsent(userId: string, input: { chats: unknown; agentId?: string; allowSaleWhileOpen?: boolean }) {
    this.get(userId);
    const chats = Array.isArray(input.chats) ? input.chats.filter((c): c is string => typeof c === "string") : typeof input.chats === "string" ? input.chats.split(/\r?\n/) : [];
    if (!chats.some(c => c.trim())) throw new HttpError(400, "chats must be a non-empty array of strings (or newline-separated text)");
    if (chats.length > 500) throw new HttpError(400, "At most 500 messages per bundle");
    if (this.db.get("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('disbursing','open')", userId)) {
      throw new HttpError(409, "An open loan holds the current bundle as collateral; repay it before replacing the bundle.");
    }
    if (input.agentId) {
      const agent = this.agent(input.agentId);
      if (agent.owner_user_id !== userId) throw new HttpError(403, `Agent ${input.agentId} belongs to another user`);
    }
    const bundle = redactChats(chats);
    const collateralRef = sha256Hex(canonicalJson(bundle));
    const sealed = seal(this.config.bundleKey, JSON.stringify(bundle));
    const bundleId = newId("bdl");
    const preview = bundle.messages.slice(0, 5).map(displayLine);
    this.db.transaction(() => {
      this.db.run("UPDATE bundles SET status = 'revoked' WHERE user_id = ? AND status = 'held'", userId);
      this.db.run("INSERT INTO bundles (id, user_id, collateral_ref, ciphertext, iv, tag, preview_json, stats_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)",
        bundleId, userId, collateralRef, sealed.ciphertext, sealed.iv, sealed.tag, JSON.stringify(preview), JSON.stringify(bundle.stats), Date.now());
      this.db.run(`INSERT INTO consents (user_id, agent_id, status, bundle_id, allow_sale_while_open, granted_at) VALUES (?, ?, 'active', ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET agent_id = excluded.agent_id, status = 'active', bundle_id = excluded.bundle_id,
        allow_sale_while_open = excluded.allow_sale_while_open, granted_at = excluded.granted_at, revoked_at = NULL`,
        userId, input.agentId ?? null, bundleId, input.allowSaleWhileOpen === false ? 0 : 1, Date.now());
    });
    return { ...this.consent(userId), before: chats, after: bundle.messages.map(displayLine) };
  }

  revokeConsent(userId: string) {
    this.get(userId);
    if (this.db.get("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('disbursing','open')", userId)) {
      throw new HttpError(409, "Consent cannot be revoked while a loan is open against it. Repay first.");
    }
    this.db.transaction(() => {
      this.db.run("UPDATE consents SET status = 'revoked', revoked_at = ? WHERE user_id = ?", Date.now(), userId);
      this.db.run("UPDATE bundles SET status = 'revoked' WHERE user_id = ? AND status = 'held'", userId);
    });
    return this.consent(userId);
  }

  consent(userId: string) {
    const consent = this.db.get<ConsentRow>("SELECT * FROM consents WHERE user_id = ?", userId);
    if (!consent) return { userId, status: "none" as const };
    const bundle = consent.bundle_id ? this.db.get<BundleRow>("SELECT * FROM bundles WHERE id = ?", consent.bundle_id) : undefined;
    return {
      userId,
      status: consent.status,
      agentId: consent.agent_id,
      allowSaleWhileOpen: consent.allow_sale_while_open === 1,
      grantedAt: new Date(consent.granted_at).toISOString(),
      revokedAt: consent.revoked_at ? new Date(consent.revoked_at).toISOString() : null,
      bundle: bundle && { id: bundle.id, status: bundle.status, collateralRef: bundle.collateral_ref, preview: JSON.parse(bundle.preview_json), stats: JSON.parse(bundle.stats_json) },
    };
  }

  bundle(bundleId: string): BundleRow {
    const bundle = this.db.get<BundleRow>("SELECT * FROM bundles WHERE id = ?", bundleId);
    if (!bundle) throw new HttpError(404, `No bundle ${bundleId}`);
    return bundle;
  }

  bundleContents(bundleId: string): RedactedBundle {
    return JSON.parse(open(this.config.bundleKey, this.bundle(bundleId))) as RedactedBundle;
  }

  /** Registers (or re-keys, with the old key) an agent owned by `userId`. Returns the API key once. */
  registerAgent(userId: string, input: { id?: string; name?: string; address?: string; masumiAgentId?: string; apiKey?: string; currentKey?: string }) {
    this.get(userId);
    if (!input.address || !/^(addr1|addr_test1)[0-9a-z]+$/.test(input.address)) throw new HttpError(400, "address must be a Cardano address");
    if (input.masumiAgentId && !/^[0-9a-f]{56,120}$/.test(input.masumiAgentId)) throw new HttpError(400, "masumiAgentId must be the registry asset id (hex)");
    const id = input.id ?? newId("agt");
    const existing = this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
    if (existing && (existing.owner_user_id !== userId || !input.currentKey || !this.keyMatches(existing, input.currentKey))) {
      throw new HttpError(403, `Agent ${id} exists; re-registering it needs its current key`);
    }
    const apiKey = input.apiKey ?? randomBytes(24).toString("base64url");
    const did = input.masumiAgentId ? `did:masumi:preprod:${input.masumiAgentId}` : `did:carsem:${id}`;
    this.db.run(`INSERT INTO agents (id, name, owner_user_id, address, did, masumi_agent_id, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, address = excluded.address, did = excluded.did, masumi_agent_id = excluded.masumi_agent_id, key_hash = excluded.key_hash`,
      id, input.name?.trim() || id, userId, input.address, did, input.masumiAgentId ?? null, keyHash(apiKey), Date.now());
    return { agent: this.agentView(this.agent(id)), apiKey };
  }

  agent(id: string): AgentRow {
    const agent = this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
    if (!agent) throw new HttpError(404, `No agent ${id}`);
    return agent;
  }

  agentView(agent: AgentRow) {
    return { id: agent.id, name: agent.name, ownerUserId: agent.owner_user_id, address: agent.address, did: agent.did, masumiAgentId: agent.masumi_agent_id };
  }

  private keyMatches(agent: AgentRow, key: string) {
    const a = Buffer.from(agent.key_hash, "hex");
    const b = Buffer.from(keyHash(key), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** `Authorization: Bearer <key>` for agent `agentId`. */
  authenticate(agentId: string, authorization: string | undefined): AgentRow {
    const key = authorization?.replace(/^Bearer\s+/i, "").trim();
    const agent = this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", agentId);
    if (!agent || !key || !this.keyMatches(agent, key)) throw new HttpError(401, "Agent authentication failed (Authorization: Bearer <agent key>)");
    return agent;
  }
}

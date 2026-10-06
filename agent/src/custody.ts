/**
 * Custody of the hosted agent wallets: one per user, encrypted at rest
 * (WALLET_KEY). ChatGPT and Claude cannot sign Cardano transactions, so the
 * user's single platform wallet lives here and signs their x402 payments.
 * Also keeps each user's agent activity (tool calls) for the dashboard.
 */
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { open, seal } from "@carsem/shared";
import type { GatewayConfig } from "./config.js";
import { preprodWallet, simWallet, type AgentWallet } from "./wallet.js";

export interface ActivityEntry { id: number; at: string; type: string; tool?: string; data: unknown }

export class Custody {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, AgentWallet>();

  constructor(private readonly config: GatewayConfig) {
    if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS wallets (user_id TEXT PRIMARY KEY, mode TEXT NOT NULL, address TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, tool TEXT, data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, id);`);
  }

  private build(secret: string): AgentWallet {
    return this.config.mode === "preprod" ? preprodWallet(secret, this.config.preprod.blockfrost) : simWallet(this.config.apiUrl, secret);
  }

  /** The user's wallet, created on first request. Idempotent. */
  create(userId: string): { address: string } {
    const existing = this.db.prepare("SELECT address, mode FROM wallets WHERE user_id = ?").get(userId) as { address: string; mode: string } | undefined;
    if (existing?.mode === this.config.mode) return { address: existing.address };
    const secret = this.config.mode === "preprod" ? generateMnemonic(wordlist, 256) : `hosted-${randomBytes(32).toString("hex")}`;
    const wallet = this.build(secret);
    this.db.prepare("INSERT INTO wallets (user_id, mode, address, secret, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET mode = excluded.mode, address = excluded.address, secret = excluded.secret")
      .run(userId, this.config.mode, wallet.address, JSON.stringify(seal(this.config.walletKey, secret)), Date.now());
    this.cache.set(userId, wallet);
    return { address: wallet.address };
  }

  wallet(userId: string): AgentWallet | undefined {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const row = this.db.prepare("SELECT secret, mode FROM wallets WHERE user_id = ?").get(userId) as { secret: string; mode: string } | undefined;
    if (!row || row.mode !== this.config.mode) return undefined;
    const wallet = this.build(open(this.config.walletKey, JSON.parse(row.secret)));
    this.cache.set(userId, wallet);
    return wallet;
  }

  log(userId: string, type: string, data: unknown, tool?: string) {
    this.db.prepare("INSERT INTO activity (user_id, at, type, tool, data_json) VALUES (?, ?, ?, ?, ?)").run(userId, Date.now(), type, tool ?? null, JSON.stringify(data ?? null));
  }

  activity(userId: string, afterId = 0, limit = 200): ActivityEntry[] {
    return (this.db.prepare("SELECT * FROM activity WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT ?").all(userId, afterId, limit) as Array<{ id: number; at: number; type: string; tool: string | null; data_json: string }>)
      .reverse().map(a => ({ id: a.id, at: new Date(a.at).toISOString(), type: a.type, tool: a.tool ?? undefined, data: JSON.parse(a.data_json) }));
  }

  close() { this.db.close(); }
}

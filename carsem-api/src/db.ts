import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uploaders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  reputation REAL NOT NULL DEFAULT 0.5, hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, uploader_id TEXT NOT NULL REFERENCES uploaders(id),
  token TEXT NOT NULL, pair TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  confidence REAL NOT NULL, horizon_minutes INTEGER NOT NULL, rationale TEXT NOT NULL,
  created_at INTEGER NOT NULL, outcome TEXT CHECK (outcome IN ('hit','miss'))
);
CREATE INDEX IF NOT EXISTS signals_token ON signals(token, created_at);
-- One row per paid signal delivery; delivery_hash is the proof logged on chain.
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, signal_id TEXT NOT NULL REFERENCES signals(id), buyer TEXT,
  payment_tx TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL, delivery_hash TEXT NOT NULL,
  log_tx TEXT, log_status TEXT NOT NULL DEFAULT 'pending', job_id TEXT, traded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, earnings_units TEXT NOT NULL DEFAULT '0', created_at INTEGER NOT NULL
);
-- Redacted chat bundle, encrypted at rest. Raw chats are never stored.
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), collateral_ref TEXT NOT NULL,
  ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, preview_json TEXT NOT NULL, stats_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','pledged','listed','revoked')), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id), agent_id TEXT, status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  bundle_id TEXT REFERENCES bundles(id), allow_sale_while_open INTEGER NOT NULL DEFAULT 1,
  granted_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES users(id), address TEXT NOT NULL,
  did TEXT NOT NULL, masumi_agent_id TEXT, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), user_id TEXT NOT NULL REFERENCES users(id),
  amount_units TEXT NOT NULL, fee_units TEXT NOT NULL, repaid_units TEXT NOT NULL DEFAULT '0',
  deadline INTEGER, status TEXT NOT NULL CHECK (status IN ('disbursing','open','repaid','defaulted')),
  collateral_ref TEXT NOT NULL, bundle_id TEXT NOT NULL REFERENCES bundles(id), disburse_tx TEXT,
  created_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS loan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(id), kind TEXT NOT NULL,
  amount_units TEXT, tx TEXT, detail_json TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY, enterprise TEXT NOT NULL, price_usdm REAL NOT NULL, data_amount INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES bundles(id), bid_id TEXT NOT NULL REFERENCES bids(id),
  buyer TEXT, price_units TEXT NOT NULL, payment_tx TEXT NOT NULL UNIQUE, loan_id TEXT,
  applied_to_loan_units TEXT NOT NULL DEFAULT '0', to_user_units TEXT NOT NULL DEFAULT '0', created_at INTEGER NOT NULL,
  UNIQUE (bundle_id, bid_id)
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id), agent_address TEXT NOT NULL,
  signal_id TEXT NOT NULL, pair TEXT NOT NULL, direction TEXT NOT NULL, size_ada REAL NOT NULL,
  entry_price REAL NOT NULL, exit_price REAL NOT NULL, pnl_units TEXT NOT NULL, outcome TEXT NOT NULL,
  payout_tx TEXT, simulated INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
-- Masumi Agentic Service API (MIP-003) jobs.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, token TEXT NOT NULL, status TEXT NOT NULL, delivery_id TEXT, created_at INTEGER NOT NULL
);
-- Simulated chain (CHAIN_MODE=simulated only).
CREATE TABLE IF NOT EXISTS sim_balances (
  address TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (address, asset)
);
CREATE TABLE IF NOT EXISTS sim_txs (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, from_address TEXT, to_address TEXT, asset TEXT, amount TEXT,
  body_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_nonces (nonce TEXT PRIMARY KEY, tx_hash TEXT NOT NULL);
`;

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.raw.exec(SCHEMA);
  }

  run(sql: string, ...params: SQLInputValue[]) { return this.raw.prepare(sql).run(...params); }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.raw.prepare(sql).get(...params) as T | undefined; }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] { return this.raw.prepare(sql).all(...params) as T[]; }

  /** Runs `fn` atomically. Synchronous on purpose: no await can interleave. */
  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.raw.close(); }
}

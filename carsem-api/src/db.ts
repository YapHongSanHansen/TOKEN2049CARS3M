import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Bump when the schema changes; an older database must be reset (npm run seed -- --reset). */
export const SCHEMA_VERSION = "3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- People. One person (KYC subject) = one account = one agent = one platform wallet.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key_hash TEXT NOT NULL UNIQUE,
  did TEXT, kyc_status TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified','rejected')),
  kyc_provider TEXT, kyc_ref TEXT, kyc_subject_hash TEXT UNIQUE, kyc_at INTEGER,
  vc_jwt TEXT, vc_revoked INTEGER NOT NULL DEFAULT 0,
  earnings_units TEXT NOT NULL DEFAULT '0', onboarded_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  allow_borrowing INTEGER NOT NULL, allow_sale_while_open INTEGER NOT NULL, sources_json TEXT NOT NULL,
  granted_at INTEGER NOT NULL, revoked_at INTEGER
);
-- The user's single AI agent. Its wallet is held by the agent gateway (custody); the address lives here.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), name TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
  did TEXT NOT NULL, masumi_agent_id TEXT, created_at INTEGER NOT NULL
);

-- Synced, redacted user context ("the AI agent has the user's information").
CREATE TABLE IF NOT EXISTS sync_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL,
  redacted TEXT NOT NULL, intents_json TEXT NOT NULL, withheld TEXT, fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE (user_id, fingerprint)
);
-- A bundle is the set of past messages the user chose to pledge for one loan. Encrypted at rest.
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL, collateral_ref TEXT NOT NULL,
  ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, preview_json TEXT NOT NULL, stats_json TEXT NOT NULL,
  item_count INTEGER NOT NULL, item_ids_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pledged','released','published')),
  created_at INTEGER NOT NULL
);

-- Platform data: trading signals, flight / hotel / product prices. Uploaded by users, not validated;
-- uploader reputation grows from outcomes and ratings.
CREATE TABLE IF NOT EXISTS uploaders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT REFERENCES users(id),
  reputation REAL NOT NULL DEFAULT 0.5, hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY, category TEXT NOT NULL CHECK (category IN ('signal','flight','hotel','product')),
  subject TEXT NOT NULL, title TEXT NOT NULL, payload_json TEXT NOT NULL, uploader_id TEXT NOT NULL REFERENCES uploaders(id),
  price_units TEXT NOT NULL, created_at INTEGER NOT NULL, outcome TEXT CHECK (outcome IN ('hit','miss'))
);
CREATE INDEX IF NOT EXISTS listings_lookup ON listings(category, subject, created_at);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES listings(id), buyer_user_id TEXT, buyer_address TEXT,
  payment_tx TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL, delivery_hash TEXT NOT NULL,
  log_tx TEXT, log_status TEXT NOT NULL DEFAULT 'pending', job_id TEXT, traded INTEGER NOT NULL DEFAULT 0, rating INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id), agent_address TEXT NOT NULL,
  listing_id TEXT NOT NULL, pair TEXT NOT NULL, direction TEXT NOT NULL, size_ada REAL NOT NULL,
  entry_price REAL NOT NULL, exit_price REAL NOT NULL, pnl_units TEXT NOT NULL, outcome TEXT NOT NULL,
  payout_tx TEXT, simulated INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), user_id TEXT NOT NULL REFERENCES users(id),
  amount_units TEXT NOT NULL, fee_units TEXT NOT NULL, repaid_units TEXT NOT NULL DEFAULT '0',
  deadline INTEGER, status TEXT NOT NULL CHECK (status IN ('disbursing','open','repaid','defaulted')),
  collateral_ref TEXT NOT NULL, bundle_id TEXT NOT NULL REFERENCES bundles(id), disburse_tx TEXT,
  created_at INTEGER NOT NULL, closed_at INTEGER
);
-- The agent asks to borrow; the user picks which past messages to pledge, then it becomes a loan.
CREATE TABLE IF NOT EXISTS loan_requests (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount_units TEXT NOT NULL, purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','expired')), loan_id TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS loan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(id), kind TEXT NOT NULL,
  amount_units TEXT, tx TEXT, detail_json TEXT, created_at INTEGER NOT NULL
);

-- Market: private enterprise bids while a loan is open; public access for everyone after a default.
CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY, enterprise TEXT NOT NULL, price_usdm REAL NOT NULL, data_amount INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL REFERENCES bundles(id), channel TEXT NOT NULL CHECK (channel IN ('enterprise','public')),
  bid_id TEXT, buyer_user_id TEXT, buyer TEXT, price_units TEXT NOT NULL, payment_tx TEXT NOT NULL UNIQUE, loan_id TEXT,
  applied_to_loan_units TEXT NOT NULL DEFAULT '0', to_user_units TEXT NOT NULL DEFAULT '0', to_platform_units TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_enterprise_once ON sales(bundle_id, bid_id) WHERE bid_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_user_once ON sales(bundle_id, buyer_user_id) WHERE buyer_user_id IS NOT NULL;

-- Masumi Agentic Service API (MIP-003) jobs.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, delivery_id TEXT, created_at INTEGER NOT NULL
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
    const table = (name: string) => !!this.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    const version = !table("users") ? SCHEMA_VERSION
      : table("meta") ? (this.raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value
      : undefined;
    if (version !== SCHEMA_VERSION) {
      this.raw.close();
      throw new Error(`The database at ${path} uses an older schema. Stop the API and run: npm run seed -- --reset`);
    }
    this.raw.exec(SCHEMA);
    this.raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);
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

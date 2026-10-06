/**
 * "The AI agent has the user's information": redacted context synced from the
 * user's AI apps. Every item is redacted on arrival (even if the client already
 * redacted it locally); raw text is never stored. When a loan starts, everything
 * synced so far is sealed into an encrypted bundle: the collateral snapshot.
 */
import { canonicalJson, displayLine, redactMessage, sha256Hex } from "@carsem/shared";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { UserRow, Users } from "./users.js";
import { open, seal } from "@carsem/shared";

export interface SyncItemRow { id: number; user_id: string; source: string; redacted: string; intents_json: string; withheld: string | null; created_at: number }
export interface BundleRow {
  id: string; user_id: string; version: number; collateral_ref: string; ciphertext: string; iv: string; tag: string;
  preview_json: string; stats_json: string; item_count: number; status: "pledged" | "released" | "published"; created_at: number;
}

export class Sync {
  constructor(private readonly db: Db, private readonly config: Config, private readonly users: Users) {}

  /** Adds redacted items. Duplicates (same redacted text) are skipped, so syncing again is safe. */
  add(user: UserRow, source: string, texts: unknown) {
    const consent = this.users.consentOf(user.id);
    if (consent?.status !== "active") throw new HttpError(403, "Sync needs your active consent", "consent_required");
    const allowed = JSON.parse(consent.sources_json) as string[];
    if (!allowed.includes(source)) throw new HttpError(403, `Your consent does not include the "${source}" source`);
    const list = (Array.isArray(texts) ? texts : typeof texts === "string" ? texts.split(/\r?\n/) : [])
      .map(t => String(t).trim()).filter(t => t.length > 1).slice(0, 2000);
    if (!list.length) throw new HttpError(400, "Nothing to sync: send items as an array of strings");
    let added = 0, duplicates = 0, withheld = 0;
    this.db.transaction(() => {
      for (const text of list) {
        const message = redactMessage(text.slice(0, 2000));
        if (message.withheld) withheld++;
        const result = this.db.run(
          "INSERT INTO sync_items (user_id, source, redacted, intents_json, withheld, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          user.id, source, message.redacted, JSON.stringify(message.intents), message.withheld ?? null, sha256Hex(`${message.redacted}`), Date.now());
        if (result.changes) added++; else duplicates++;
      }
    });
    return { added, duplicates, withheld, ...this.stats(user.id) };
  }

  stats(userId: string) {
    const total = this.db.get<{ n: number; last: number | null }>("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM sync_items WHERE user_id = ?", userId)!;
    const bySource = this.db.all<{ source: string; n: number }>("SELECT source, COUNT(*) AS n FROM sync_items WHERE user_id = ? GROUP BY source", userId);
    const latestBundle = this.db.get<BundleRow>("SELECT * FROM bundles WHERE user_id = ? ORDER BY version DESC LIMIT 1", userId);
    const sinceSnapshot = latestBundle
      ? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_items WHERE user_id = ? AND created_at > ?", userId, latestBundle.created_at)!.n
      : total.n;
    return {
      items: total.n,
      lastSyncedAt: total.last && new Date(total.last).toISOString(),
      bySource: Object.fromEntries(bySource.map(s => [s.source, s.n])),
      minimumForBorrowing: this.config.minSyncItems,
      readyToBorrow: total.n >= this.config.minSyncItems,
      latestCollateral: latestBundle && { bundleId: latestBundle.id, version: latestBundle.version, status: latestBundle.status, items: latestBundle.item_count, collateralRef: latestBundle.collateral_ref, at: new Date(latestBundle.created_at).toISOString() },
      newSinceLastCollateral: sinceSnapshot,
    };
  }

  /** The most recent redacted lines, for the user's own view. */
  preview(userId: string, limit = 20) {
    return this.db.all<SyncItemRow>("SELECT * FROM sync_items WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit)
      .map(i => ({ source: i.source, line: displayLine({ redacted: i.redacted, intents: JSON.parse(i.intents_json), withheld: i.withheld ?? undefined }), at: new Date(i.created_at).toISOString() }));
  }

  /**
   * Seals everything synced so far into the next bundle version (status pledged).
   * Called inside the borrow transaction: the collateral is exactly what was synced when borrowing started.
   */
  snapshot(userId: string): BundleRow {
    const items = this.db.all<SyncItemRow>("SELECT * FROM sync_items WHERE user_id = ? ORDER BY id", userId);
    if (items.length < this.config.minSyncItems) {
      throw new HttpError(409, `Sync at least ${this.config.minSyncItems} items of your context before borrowing (you have ${items.length}). Use the sync_context tool or the local sync helper.`, "sync_required");
    }
    const messages = items.map(i => ({ redacted: i.redacted, intents: JSON.parse(i.intents_json) as string[], withheld: i.withheld ?? undefined, source: i.source }));
    const intents: Record<string, number> = {};
    for (const m of messages) for (const intent of m.intents) intents[intent] = (intents[intent] ?? 0) + 1;
    const stats = { messages: messages.length, withheld: messages.filter(m => m.withheld).length, intents, sources: [...new Set(messages.map(m => m.source))] };
    const bundle = { version: 1, userDid: this.users.get(userId).did, messages, stats };
    const collateralRef = sha256Hex(canonicalJson(bundle));
    const sealed = seal(this.config.bundleKey, JSON.stringify(bundle));
    const version = (this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM bundles WHERE user_id = ?", userId)?.v ?? 0) + 1;
    const id = newId("bdl");
    this.db.run(`INSERT INTO bundles (id, user_id, version, collateral_ref, ciphertext, iv, tag, preview_json, stats_json, item_count, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pledged', ?)`,
      id, userId, version, collateralRef, sealed.ciphertext, sealed.iv, sealed.tag,
      JSON.stringify(messages.filter(m => !m.withheld).slice(0, 3).map(displayLine)), JSON.stringify(stats), messages.length, Date.now());
    return this.bundle(id);
  }

  bundle(id: string): BundleRow {
    const bundle = this.db.get<BundleRow>("SELECT * FROM bundles WHERE id = ?", id);
    if (!bundle) throw new HttpError(404, `No bundle ${id}`);
    return bundle;
  }

  /** What a buyer receives: redacted lines only, withheld categories removed. */
  contents(id: string) {
    const bundle = this.bundle(id);
    const data = JSON.parse(open(this.config.bundleKey, bundle)) as { messages: Array<{ redacted: string; intents: string[]; withheld?: string }>; stats: unknown };
    return { bundleId: id, version: bundle.version, collateralRef: bundle.collateral_ref, stats: data.stats, messages: data.messages.filter(m => !m.withheld).map(displayLine) };
  }
}

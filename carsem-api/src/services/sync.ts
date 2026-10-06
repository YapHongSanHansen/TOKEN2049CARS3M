/**
 * The user's past messages ("the AI agent has the user's information"),
 * collected from their AI apps, exports and imports. Every message is redacted
 * on arrival (even if it was already redacted on the user's machine); raw text
 * is never stored. When the agent needs to borrow, the user chooses which of
 * these messages to pledge, and only those are sealed as that loan's collateral.
 */
import { SAMPLE_CHATS, canonicalJson, displayLine, open, redactMessage, seal, sha256Hex, userMessagesFromChatGptExport, userMessagesFromClaudeExport } from "@carsem/shared";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError, newId } from "./errors.js";
import type { UserRow, Users } from "./users.js";

export interface SyncItemRow { id: number; user_id: string; source: string; redacted: string; intents_json: string; withheld: string | null; created_at: number }
export interface BundleRow {
  id: string; user_id: string; version: number; collateral_ref: string; ciphertext: string; iv: string; tag: string;
  preview_json: string; stats_json: string; item_count: number; item_ids_json: string; status: "pledged" | "released" | "published"; created_at: number;
}

export class Sync {
  constructor(private readonly db: Db, private readonly config: Config, private readonly users: Users) {}

  /** Adds messages (redacted here). Duplicates are skipped, so syncing again is safe. */
  add(user: UserRow, source: string, texts: unknown) {
    const consent = this.users.consentOf(user.id);
    if (consent?.status !== "active") throw new HttpError(403, "Adding messages needs your active consent", "consent_required");
    const allowed = JSON.parse(consent.sources_json) as string[];
    if (!allowed.includes(source)) throw new HttpError(403, `Your consent does not include the "${source}" source`);
    const list = (Array.isArray(texts) ? texts : typeof texts === "string" ? texts.split(/\r?\n/) : [])
      .map(t => String(t).replace(/\s+/g, " ").trim()).filter(t => t.length > 3).slice(0, 2000);
    if (!list.length) throw new HttpError(400, "Nothing to add: send messages as an array of strings");
    let added = 0, duplicates = 0, withheld = 0;
    this.db.transaction(() => {
      for (const text of list) {
        const message = redactMessage(text.slice(0, 1000));
        if (message.withheld) withheld++;
        const result = this.db.run(
          "INSERT INTO sync_items (user_id, source, redacted, intents_json, withheld, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          user.id, source, message.redacted, JSON.stringify(message.intents), message.withheld ?? null, sha256Hex(message.redacted), Date.now());
        if (result.changes) added++; else duplicates++;
      }
    });
    return { added, duplicates, withheld, ...this.stats(user.id) };
  }

  /** Reads a ChatGPT or Claude export (conversations.json) and adds the user's own messages. */
  import(user: UserRow, format: unknown, content: unknown) {
    let json: unknown;
    try { json = typeof content === "string" ? JSON.parse(content) : content; }
    catch { throw new HttpError(400, "content must be the conversations.json file"); }
    const messages = format === "chatgpt" ? userMessagesFromChatGptExport(json) : format === "claude" ? userMessagesFromClaudeExport(json) : undefined;
    if (!messages) throw new HttpError(400, "format must be chatgpt or claude");
    if (!messages.length) throw new HttpError(400, `No user messages found in that ${format} export`);
    return this.add(user, "export", messages.slice(0, 300));
  }

  addSample(user: UserRow) { return this.add(user, "demo", SAMPLE_CHATS); }

  stats(userId: string) {
    const total = this.db.get<{ n: number; last: number | null }>("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM sync_items WHERE user_id = ? AND withheld IS NULL", userId)!;
    const bySource = this.db.all<{ source: string; n: number }>("SELECT source, COUNT(*) AS n FROM sync_items WHERE user_id = ? AND withheld IS NULL GROUP BY source", userId);
    return {
      messages: total.n,
      lastAddedAt: total.last && new Date(total.last).toISOString(),
      bySource: Object.fromEntries(bySource.map(s => [s.source, s.n])),
      minimumToPledge: this.config.minPledgeItems,
      canBorrow: total.n >= this.config.minPledgeItems,
    };
  }

  /** The user's past messages that can be pledged (withheld topics never can), newest first. */
  messages(userId: string, limit = 100) {
    const pledged = new Map<number, string>();
    for (const b of this.db.all<{ item_ids_json: string; status: string; id: string }>("SELECT b.item_ids_json, b.status, b.id FROM bundles b WHERE b.user_id = ? AND b.status IN ('pledged','published')", userId)) {
      for (const id of JSON.parse(b.item_ids_json) as number[]) pledged.set(id, b.status === "pledged" ? "locked for an open loan" : "published after a default");
    }
    return this.db.all<SyncItemRow>("SELECT * FROM sync_items WHERE user_id = ? AND withheld IS NULL ORDER BY id DESC LIMIT ?", userId, limit)
      .map(i => ({ id: i.id, source: i.source, text: i.redacted, intents: JSON.parse(i.intents_json) as string[], at: new Date(i.created_at).toISOString(), state: pledged.get(i.id) ?? null }));
  }

  /** Seals the messages the user chose into the next bundle version (status pledged). */
  snapshot(userId: string, itemIds: unknown): BundleRow {
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(Number).filter(Number.isInteger))];
    if (ids.length < this.config.minPledgeItems) {
      throw new HttpError(400, `Choose at least ${this.config.minPledgeItems} past messages to pledge (you chose ${ids.length})`, "selection_required");
    }
    const items = this.db.all<SyncItemRow>(`SELECT * FROM sync_items WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, userId, ...ids);
    if (items.length !== ids.length) throw new HttpError(400, "Some of those messages are not yours");
    if (items.some(i => i.withheld)) throw new HttpError(400, "Withheld (sensitive) messages cannot be pledged");
    const messages = items.map(i => ({ redacted: i.redacted, intents: JSON.parse(i.intents_json) as string[], source: i.source }));
    const intents: Record<string, number> = {};
    for (const m of messages) for (const intent of m.intents) intents[intent] = (intents[intent] ?? 0) + 1;
    const stats = { messages: messages.length, withheld: 0, intents, sources: [...new Set(messages.map(m => m.source))] };
    const bundle = { version: 1, userDid: this.users.get(userId).did, messages, stats };
    const collateralRef = sha256Hex(canonicalJson(bundle));
    const sealed = seal(this.config.bundleKey, JSON.stringify(bundle));
    const version = (this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM bundles WHERE user_id = ?", userId)?.v ?? 0) + 1;
    const id = newId("bdl");
    this.db.run(`INSERT INTO bundles (id, user_id, version, collateral_ref, ciphertext, iv, tag, preview_json, stats_json, item_count, item_ids_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pledged', ?)`,
      id, userId, version, collateralRef, sealed.ciphertext, sealed.iv, sealed.tag,
      JSON.stringify(messages.slice(0, 3).map(displayLine)), JSON.stringify(stats), messages.length, JSON.stringify(ids), Date.now());
    return this.bundle(id);
  }

  bundle(id: string): BundleRow {
    const bundle = this.db.get<BundleRow>("SELECT * FROM bundles WHERE id = ?", id);
    if (!bundle) throw new HttpError(404, `No bundle ${id}`);
    return bundle;
  }

  /** What a buyer receives: the pledged messages, redacted. */
  contents(id: string) {
    const bundle = this.bundle(id);
    const data = JSON.parse(open(this.config.bundleKey, bundle)) as { messages: Array<{ redacted: string; intents: string[] }>; stats: unknown };
    return { bundleId: id, version: bundle.version, collateralRef: bundle.collateral_ref, stats: data.stats, messages: data.messages.map(m => displayLine(m)) };
  }
}

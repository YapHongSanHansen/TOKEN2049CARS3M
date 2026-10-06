/**
 * npm run sync -- --source <hermes|claude-code|chatgpt-export|claude-export|file> [path] [--profile carsem] [--yes]
 *
 * Syncs YOUR context to CARSEM so it can back a loan. Everything is read and
 * REDACTED ON THIS MACHINE; only the redacted lines are uploaded (and CARSEM
 * redacts them again on arrival). Nothing is sent without --yes.
 *
 *   hermes          Hermes memories (USER.md, MEMORY.md) + your recent messages (state.db)
 *   claude-code     your recent prompts in ~/.claude/projects/*.jsonl
 *   chatgpt-export  conversations.json from ChatGPT → Settings → Data controls → Export
 *   claude-export   conversations.json from Claude → Settings → Privacy → Export data
 *   file            any text file, one message per line
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { displayLine, redactMessage } from "@carsem/shared";
import { api } from "./api.js";
import { loadGatewayConfig } from "./config.js";

type Source = "hermes" | "claude-code" | "chatgpt-export" | "claude-export" | "file";
const MAX_ITEMS = 300;

function hermesHome(profile?: string) {
  const base = process.env.HERMES_HOME?.trim() || (process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes") : join(homedir(), ".hermes"));
  return profile ? join(base, "profiles", profile) : base;
}

function fromHermes(profile?: string): string[] {
  const home = hermesHome(profile);
  const out: string[] = [];
  for (const file of ["USER.md", "MEMORY.md"]) {
    const path = join(home, "memories", file);
    if (!existsSync(path)) continue;
    out.push(...readFileSync(path, "utf8").split(/\r?\n/).map(l => l.replace(/^[-*#>\s]+/, "").trim()).filter(l => l.length > 12));
  }
  const dbPath = join(home, "state.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT content FROM messages WHERE role = 'user' AND content IS NOT NULL ORDER BY timestamp DESC LIMIT ?").all(MAX_ITEMS) as Array<{ content: string }>;
      out.push(...rows.map(r => r.content));
    } finally { db.close(); }
  }
  if (!out.length) throw new Error(`Nothing found in ${home} (memories/USER.md, memories/MEMORY.md, state.db)`);
  return out;
}

function fromClaudeCode(): string[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) throw new Error(`${root} not found`);
  const files = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())
    .flatMap(d => readdirSync(join(root, d.name)).filter(f => f.endsWith(".jsonl")).map(f => join(root, d.name, f)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 40);
  const out: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (entry.type !== "user" || entry.message?.role !== "user") continue;
        const content = entry.message.content;
        const text = typeof content === "string" ? content
          : Array.isArray(content) ? content.filter((c: { type?: string }) => c?.type === "text").map((c: { text?: string }) => c.text ?? "").join(" ") : "";
        if (text && !text.startsWith("<")) out.push(text);
      } catch { /* skip partial lines */ }
    }
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function fromChatGptExport(path: string): string[] {
  const conversations = JSON.parse(readFileSync(path, "utf8")) as Array<{ mapping?: Record<string, { message?: { author?: { role?: string }; content?: { parts?: unknown[] } } }> }>;
  return conversations.flatMap(c => Object.values(c.mapping ?? {}))
    .filter(n => n.message?.author?.role === "user")
    .map(n => (n.message?.content?.parts ?? []).filter(p => typeof p === "string").join(" "));
}

function fromClaudeExport(path: string): string[] {
  const conversations = JSON.parse(readFileSync(path, "utf8")) as Array<{ chat_messages?: Array<{ sender?: string; text?: string }> }>;
  return conversations.flatMap(c => c.chat_messages ?? []).filter(m => m.sender === "human" && m.text).map(m => m.text!);
}

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const source = option("source") as Source | undefined;
const path = option("path") ?? args.find(a => !a.startsWith("--") && a !== source && a !== option("profile"));
if (!source) {
  console.log("usage: npm run sync -- --source <hermes|claude-code|chatgpt-export|claude-export|file> [--path <file>] [--profile <hermes profile>] [--yes]");
  process.exit(1);
}

const config = loadGatewayConfig();
const key = process.env.CARSEM_KEY?.trim();
if (!key) { console.error("Set CARSEM_KEY (your key from onboarding) in .env.local or the shell."); process.exit(1); }

const raw = source === "hermes" ? fromHermes(option("profile"))
  : source === "claude-code" ? fromClaudeCode()
  : source === "chatgpt-export" ? fromChatGptExport(path!)
  : source === "claude-export" ? fromClaudeExport(path!)
  : readFileSync(path!, "utf8").split(/\r?\n/);

// Redact here, before anything leaves this machine.
const seen = new Set<string>();
const redacted = raw.map(t => t.replace(/\s+/g, " ").trim()).filter(t => t.length >= 12).map(t => t.slice(0, 400))
  .map(t => redactMessage(t)).filter(m => !m.withheld && !seen.has(m.redacted) && seen.add(m.redacted)).slice(0, MAX_ITEMS);

console.log(`\n${raw.length} messages read from ${source} → ${redacted.length} redacted lines (withheld and duplicates dropped). Sample:\n`);
for (const m of redacted.slice(0, 8)) console.log(`  · ${displayLine(m)}`);
if (!args.includes("--yes")) {
  console.log("\nNothing was sent. Re-run with --yes to upload these redacted lines to CARSEM.");
  process.exit(0);
}
const sourceTag = source === "hermes" ? "hermes" : source === "claude-code" ? "claude_code" : "export";
let total: { added: number; duplicates: number; items: number; readyToBorrow: boolean } | undefined;
for (let i = 0; i < redacted.length; i += 200) {
  total = await api(config.apiUrl, "/me/sync", { body: { source: sourceTag, items: redacted.slice(i, i + 200).map(m => m.redacted) }, headers: { Authorization: `Bearer ${key}` } });
}
console.log(`\nSynced: ${total?.added ?? 0} new, ${total?.duplicates ?? 0} already there. ${total?.items} items in your CARSEM context${total?.readyToBorrow ? " (ready to back a loan)" : ""}.`);

/**
 * carsem: the CARSEM command line.
 *
 *   carsem link            connect your wallet: opens the CARSEM web app, you sign in with Lace, the key comes back here
 *   carsem codex           plug CARSEM into Codex (writes [mcp_servers.carsem] into ~/.codex/config.toml)
 *   carsem chatgpt         the custom-connector URL for ChatGPT (web / desktop)
 *   carsem status          your account, wallet, credit limit and loan
 *   carsem ask "<text>"    talk to your agent from the terminal
 *   carsem mcp             (used by Codex) an MCP server on stdio that forwards to your CARSEM agent
 *   carsem unlink          forget the key on this machine
 *
 * Config: ~/.carsem/config.json  { api, gateway, web, key }
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

interface Config { api: string; gateway: string; web: string; key?: string }
const HOME = join(homedir(), ".carsem");
const CONFIG = join(HOME, "config.json");
const DEFAULTS: Config = {
  api: process.env.CARSEM_API_URL ?? "http://localhost:4021",
  gateway: process.env.CARSEM_GATEWAY_URL ?? "http://localhost:4031",
  web: process.env.CARSEM_WEB_URL ?? "http://localhost:5173",
};

const loadConfig = (): Config => {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG, "utf8")) as Partial<Config> }; } catch { return { ...DEFAULTS }; }
};
const saveConfig = (config: Config) => { mkdirSync(HOME, { recursive: true }); writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n"); };
const say = (line = "") => { process.stderr.write(line + "\n"); };
const fail = (line: string): never => { say(`✖ ${line}`); process.exit(1); };

async function api<T = any>(config: Config, base: "api" | "gateway", path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (config.key) headers.Authorization = `Bearer ${config.key}`;
  let body = init.body;
  if (init.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.json); }
  const response = await fetch(`${config[base]}${path}`, { ...init, headers, body });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* plain */ }
  if (!response.ok) throw new Error(data?.error ?? `${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
  return data as T;
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* the link is printed anyway */ }
}

// ---- link: the browser does the wallet part, then hands the key to this process ---------------

async function link(config: Config) {
  const nonce = randomBytes(12).toString("base64url");
  const key = await new Promise<string>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", config.web);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
      if (req.method !== "POST" || req.url !== `/key/${nonce}`) { res.writeHead(404).end(); return; }
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const { key } = JSON.parse(body) as { key?: string };
          if (!key?.startsWith("csm_")) throw new Error("no key");
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          server.close();
          resolve(key);
        } catch { res.writeHead(400).end(); }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const url = `${config.web}/?cli=${port}&nonce=${nonce}#start`;
      say("Opening CARSEM in your browser. Sign in with Lace (preprod), finish KYC and consent; the key comes back here.");
      say(`If nothing opened: ${url}`);
      openBrowser(url);
    });
    setTimeout(() => { server.close(); reject(new Error("Timed out after 10 minutes. Run `carsem link` again.")); }, 600_000).unref();
  });
  saveConfig({ ...config, key });
  say("✔ Linked. Key saved to " + CONFIG);
  await status({ ...config, key });
  say("\nNext: `carsem codex` plugs CARSEM into Codex; `carsem chatgpt` prints the ChatGPT connector URL.");
}

// ---- codex: the MCP server entry in ~/.codex/config.toml -----------------------------------------

function codexConfigPath() { return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"); }

function codex(config: Config) {
  if (!config.key) fail("Not linked yet. Run `carsem link` first.");
  const path = codexConfigPath();
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  // Codex starts `carsem mcp` and talks MCP over stdio; the key stays in ~/.carsem, never in Codex's config.
  const section = `[mcp_servers.carsem]\ncommand = "${process.platform === "win32" ? "carsem.cmd" : "carsem"}"\nargs = ["mcp"]\n`;
  const stripped = current.replace(/\[mcp_servers\.carsem\][\s\S]*?(?=\n\[|\s*$)/, "").trimEnd();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${stripped}${stripped ? "\n\n" : ""}${section}`);
  say(`✔ Added [mcp_servers.carsem] to ${path}`);
  say("Start `codex` and ask: \"Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades.\"");
}

// ---- mcp: stdio server for Codex, forwarding every tool to the gateway ----------------------------

async function mcp(config: Config) {
  if (!config.key) fail("Not linked yet. Run `carsem link` first.");
  const tools = await api<Array<{ name: string; title: string; description: string; input_schema: Record<string, unknown> }>>(config, "gateway", "/v1/tools");
  const server = new Server({ name: "carsem", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.input_schema as { type: "object"; [k: string]: unknown } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await api(config, "gateway", `/v1/tools/${encodeURIComponent(request.params.name)}`, { method: "POST", json: request.params.arguments ?? {} });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !!(result as { error?: string })?.error };
    } catch (error) {
      return { content: [{ type: "text", text: (error as Error).message }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

// ---- status / ask / chatgpt ---------------------------------------------------------------------------

async function status(config: Config) {
  if (!config.key) fail("Not linked yet. Run `carsem link`.");
  const me = await api(config, "api", "/me");
  say(`Account   ${me.name} · ${me.onboarded ? "verified" : "onboarding not finished: " + me.connect.onboarding}`);
  say(`Wallet    ${me.wallet.id}`);
  if (me.credit) say(`Credit    score ${me.credit.score}/100 · limit ${me.credit.limitUsdm} USDM`);
  if (me.onboarded) {
    const s = await api(config, "gateway", "/v1/me").catch(() => null);
    if (s?.wallet) say(`Agent     ${s.wallet.USDM} USDM · ${s.wallet.address}`);
    if (s?.openLoan) say(`Loan      ${s.openLoan.outstanding_usdm} USDM due ${s.openLoan.deadline}`);
  }
}

async function ask(config: Config, message: string) {
  if (!config.key) fail("Not linked yet. Run `carsem link`.");
  if (!message) fail('Usage: carsem ask "Find me trading signals on CARSEM"');
  const response = await fetch(`${config.gateway}/v1/ask`, { method: "POST", headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  for await (const chunk of response.body) process.stdout.write(chunk);
}

function chatgpt(config: Config) {
  if (!config.key) fail("Not linked yet. Run `carsem link`.");
  say("ChatGPT → Settings → Connectors → add a custom connector with this URL (it needs a public HTTPS gateway):");
  process.stdout.write(`${config.gateway}/mcp/k/${config.key}\n`);
}

// ---- main ---------------------------------------------------------------------------------------------

const [command = "help", ...rest] = process.argv.slice(2);
const config = loadConfig();
const commands: Record<string, () => Promise<void> | void> = {
  link: () => link(config),
  codex: () => codex(config),
  mcp: () => mcp(config),
  status: () => status(config),
  ask: () => ask(config, rest.join(" ")),
  chatgpt: () => chatgpt(config),
  unlink: () => { saveConfig({ ...config, key: undefined }); say("✔ Key removed from this machine."); },
  help: () => say(`carsem — your CARSEM agent from the terminal

  carsem link            connect your wallet (opens the browser)
  carsem codex           plug CARSEM into Codex
  carsem chatgpt         the ChatGPT connector URL
  carsem status          account, credit limit, wallet, loan
  carsem ask "<text>"    talk to your agent
  carsem unlink          forget the key

Server: ${config.api} (set CARSEM_API_URL / CARSEM_GATEWAY_URL / CARSEM_WEB_URL to point elsewhere)`),
};
const run = commands[command];
if (!run) fail(`Unknown command "${command}". Try: carsem help`);
Promise.resolve(run()).catch(error => fail((error as Error).message));

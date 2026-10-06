/**
 * End-to-end on the simulated chain: real carsem-api, real agent gateway, a real
 * MCP client (what Hermes / Claude Code / ChatGPT use), the official x402 SDK.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { NETWORK, SimWallet, redactMessage, toUnits } from "@carsem/shared";
import type { GatewayConfig } from "../agent/src/config.js";
import { Custody } from "../agent/src/custody.js";
import { createGateway } from "../agent/src/gateway.js";
import { simWallet } from "../agent/src/wallet.js";
import { paidFetch } from "../agent/src/x402Client.js";
import { createApp } from "../carsem-api/src/app.js";
import { loadConfig, type Config } from "../carsem-api/src/config.js";
import { Db } from "../carsem-api/src/db.js";
import { seedDemo } from "../carsem-api/src/demo.js";

const closers: Array<() => void> = [];
after(() => closers.forEach(close => close()));

async function listen(app: { listen: (port: number, host: string) => import("node:http").Server }) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startStack(overrides: Partial<Config> = {}) {
  const config: Config = { ...loadConfig({ CHAIN_MODE: "simulated", DB_PATH: ":memory:" }), ...overrides };
  const db = new Db(":memory:");
  seedDemo(db, config);
  const { app, ctx } = await createApp(config, { db });
  const apiUrl = await listen(app);
  config.publicUrl = apiUrl;
  const gatewayConfig: GatewayConfig = {
    mode: "simulated", apiUrl, port: 0, publicUrl: "", serviceToken: config.serviceToken, walletKey: Buffer.alloc(32, 7),
    dbPath: ":memory:", maxPayment: toUnits("60"), tradeSizeAda: 400, openai: { apiKey: "", model: "" }, preprod: { blockfrost: { baseUrl: "", projectId: "" } },
  };
  const custody = new Custody(gatewayConfig);
  const gatewayUrl = await listen(createGateway(gatewayConfig, custody).app);
  gatewayConfig.publicUrl = gatewayUrl;
  config.gatewayUrl = gatewayUrl;
  closers.push(() => { custody.close(); db.close(); });
  return { config, ctx, apiUrl, gatewayUrl, custody };
}

const call = async (url: string, init: { method?: string; body?: unknown; key?: string } = {}) => {
  const response = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: await response.json() as any };
};

let docCounter = 0;
async function onboard(apiUrl: string, name: string, options: { doc?: string; sync?: string[]; allowSaleWhileOpen?: boolean } = {}) {
  const { body: { apiKey } } = await call(`${apiUrl}/onboarding/start`, { body: { name } });
  const kyc = await call(`${apiUrl}/onboarding/kyc`, { key: apiKey, body: { fullName: name, documentNumber: options.doc ?? `DOC${++docCounter}${Date.now()}`, country: "MY" } });
  assert.equal(kyc.status, 200, JSON.stringify(kyc.body));
  assert.equal((await call(`${apiUrl}/onboarding/consent`, { key: apiKey, body: { allowBorrowing: true, allowSaleWhileOpen: options.allowSaleWhileOpen ?? true } })).status, 200);
  const complete = await call(`${apiUrl}/onboarding/complete`, { key: apiKey, body: {} });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  if (options.sync) assert.equal((await call(`${apiUrl}/me/sync`, { key: apiKey, body: { source: "assistant", items: options.sync } })).status, 200);
  return { key: apiKey as string, profile: complete.body };
}

async function mcp(gatewayUrl: string, key: string) {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  closers.push(() => { void client.close(); });
  return {
    client,
    tool: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0].text);
    },
  };
}

/** What the user does in the app: pick past messages for the agent's pending borrow request. */
async function approvePending(apiUrl: string, key: string, count = 3) {
  for (let i = 0; i < 100; i++) {
    const { body: pending } = await call(`${apiUrl}/me/loan-requests`, { key });
    if (pending.length) {
      const { body: history } = await call(`${apiUrl}/me/messages`, { key });
      const ids = history.messages.slice(0, count).map((m: { id: number }) => m.id);
      return call(`${apiUrl}/loans`, { key, body: { requestId: pending[0].id, messageIds: ids } });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("no pending borrow request");
}

const CHATS = [
  "Cheapest flight from Kuala Lumpur to Singapore next weekend",
  "My girlfriend's birthday is on 30th Sept, what should I buy? Budget RM 300",
  "Cheapest hotel at Singapore Geylang",
  "Find me trading signals, I want pocket money on Cardano DEX trades",
];

describe("onboarding gate (Masumi DID + KYC + consent)", () => {
  it("blocks the platform until the user is verified, then issues a DID, credential and one agent wallet", async () => {
    const { apiUrl, gatewayUrl } = await startStack();
    const { body: { apiKey } } = await call(`${apiUrl}/onboarding/start`, { body: { name: "Bob" } });
    const { tool } = await mcp(gatewayUrl, apiKey);
    const status = await tool("carsem_status");
    assert.equal(status.onboarded, false);
    assert.match(status.next, /#start/);
    assert.match((await tool("buy_data", { category: "signal", query: "MIN" })).error, /onboarding/i);
    assert.equal((await call(`${apiUrl}/loans`, { key: apiKey, body: { amount: "5" } })).status, 403);

    // Consent needs KYC first, and consent is required to finish.
    assert.equal((await call(`${apiUrl}/onboarding/consent`, { key: apiKey, body: { allowBorrowing: true } })).status, 403);
    await call(`${apiUrl}/onboarding/kyc`, { key: apiKey, body: { fullName: "Bob", documentNumber: "A1234567", country: "MY" } });
    assert.equal((await call(`${apiUrl}/onboarding/complete`, { key: apiKey, body: {} })).status, 403);
    assert.equal((await call(`${apiUrl}/onboarding/consent`, { key: apiKey, body: { allowBorrowing: false } })).status, 400);
    await call(`${apiUrl}/onboarding/consent`, { key: apiKey, body: { allowBorrowing: true } });
    const { body: profile } = await call(`${apiUrl}/onboarding/complete`, { key: apiKey, body: {} });
    assert.equal(profile.onboarded, true);
    assert.match(profile.identity.did, /^did:web:[^:]+:users:usr_/);
    assert.match(profile.agent.address, /^addr_test1sim/);

    // The credential verifies; a tampered one does not; the DID resolves.
    assert.equal((await call(`${apiUrl}/credentials/verify`, { body: { jwt: profile.identity.credential.jwt } })).body.valid, true);
    const [h, p, s] = profile.identity.credential.jwt.split(".");
    assert.equal((await call(`${apiUrl}/credentials/verify`, { body: { jwt: `${h}.${p}.${s.slice(0, -4)}AAAA` } })).status, 400);
    assert.equal((await call(`${apiUrl}/users/${profile.id}/did.json`)).body.id, profile.identity.did);

    // Agent wallet got the starter funds: 0.05 USDM, not enough for a 5 USDM paywall.
    const now = await tool("carsem_status");
    assert.equal(now.onboarded, true);
    assert.equal(now.wallet.USDM, "0.05");
  });

  it("allows one account per identity document (one platform wallet per person)", async () => {
    const { apiUrl } = await startStack();
    await onboard(apiUrl, "Carol", { doc: "P9999999" });
    const { body: { apiKey } } = await call(`${apiUrl}/onboarding/start`, { body: { name: "Carol again" } });
    const second = await call(`${apiUrl}/onboarding/kyc`, { key: apiKey, body: { fullName: "Carol", documentNumber: "P 9999-999", country: "MY" } });
    assert.equal(second.status, 409);
  });
});

describe("the drawing's flow over MCP", () => {
  it("search → 402 → 0.05 < 5 → sync → collateral borrowing → pay → data → trade → repay", async () => {
    const { apiUrl, gatewayUrl, ctx } = await startStack({ dexOutcome: "win" });
    const { key } = await onboard(apiUrl, "Alice");
    const { client, tool } = await mcp(gatewayUrl, key);
    assert.ok((await client.listTools()).tools.length >= 12);

    const found = await tool("search_data", { category: "signal", query: "MIN" });
    const listingId = found.results[0].listing_id;
    const first = await tool("buy_data", { listing_id: listingId });
    assert.equal(first.status, "insufficient_funds");
    assert.equal(first.balance_usdm, "0.05");

    const empty = await tool("borrow", { amount_usdm: "5", purpose: "LONG MIN/ADA" });
    assert.equal(empty.status, "selection_required");
    assert.equal(empty.your_messages.length, 0);
    assert.match(empty.next, /add_messages/);
    assert.equal((await tool("add_messages", { messages: CHATS })).total_messages, 4);
    const ask = await tool("borrow", { amount_usdm: "5", purpose: "LONG MIN/ADA" });
    assert.equal(ask.status, "selection_required");
    assert.equal(ask.your_messages.length, 4);
    // The user picks 3 of their 4 messages; the agent never chooses for them.
    const chosen = ask.your_messages.filter((m: { text: string }) => !m.text.includes("Geylang")).map((m: { id: number }) => m.id);
    assert.match((await tool("borrow", { amount_usdm: "5", message_ids: chosen.slice(0, 2), request_id: ask.request_id })).error, /at least 3/);
    const loan = await tool("borrow", { amount_usdm: "5", message_ids: chosen, request_id: ask.request_id });
    assert.equal(loan.status, "borrowed");
    assert.match(loan.collateral, /3 of your past messages pledged/);
    assert.equal((await tool("borrow_status", { request_id: ask.request_id })).status, "borrowed");

    const bought = await tool("buy_data", { listing_id: listingId });
    assert.equal(bought.status, "delivered");
    assert.equal(bought.listing.data.token, "MIN");
    const trade = await tool("trade_signal", { delivery_id: bought.delivery_id });
    assert.equal(trade.outcome, "win");
    const repaid = await tool("repay_loan");
    assert.equal(repaid.status, "repaid");
    assert.equal(repaid.collateral, "released");

    await new Promise(resolve => setTimeout(resolve, 50));
    const delivery = ctx.data.deliveryView(ctx.data.delivery(bought.delivery_id));
    assert.equal(delivery.decisionLog.status, "confirmed");
    assert.match(delivery.request.buyer, /^did:web:/);
    const [view] = ctx.lending.list({});
    assert.deepEqual(view.events.map(e => e.kind), ["collateral_locked", "disbursed", "repayment", "collateral_released"]);
    // Messages were stored redacted, and only the chosen ones are locked.
    const history = (await call(`${apiUrl}/me/messages`, { key })).body.messages;
    const text = history.map((m: { text: string }) => m.text).join(" ");
    assert.ok(!text.includes("30th Sept") && text.includes("[PERSON]") && text.includes("[DATE]"));
    assert.equal(history.find((m: { text: string }) => m.text.includes("Geylang")).state, null);
  });

  it("buys live prices (flights, hotels, products) and lets users upload and rate data", async () => {
    const { apiUrl, gatewayUrl } = await startStack();
    const { key } = await onboard(apiUrl, "Dan", { sync: CHATS });
    await fetch(`${apiUrl}/sim/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: (await call(`${apiUrl}/me`, { key })).body.agent.address, usdm: "3" }) });
    const { tool } = await mcp(gatewayUrl, key);
    const flights = await tool("search_data", { category: "flight", query: "KUL-SIN" });
    assert.ok(flights.results.length >= 3);
    const flight = await tool("buy_data", { category: "flight", query: "KUL-SIN" });
    assert.equal(flight.status, "delivered");
    assert.equal(flight.listing.data.from, "KUL");
    assert.equal((await tool("buy_data", { category: "hotel", query: "Geylang" })).listing.data.area, "Geylang");

    const upload = await tool("upload_data", { category: "product", data: { name: "Pokemon 30th Anniversary Booster Pack", store: "Mydin", price: 35, currency: "MYR" } });
    assert.equal(upload.validated, false);
    assert.equal((await tool("rate_data", { delivery_id: flight.delivery_id, useful: true })).rating, "useful");
    const missing = await tool("upload_data", { category: "signal", data: { token: "MIN" } });
    assert.match(missing.error, /needs/);
  });
});

describe("curl", () => {
  it("POST /v1/ask runs the whole flow in plain English (scripted brain, no OpenAI key)", async () => {
    const { apiUrl, gatewayUrl, ctx } = await startStack();
    const { key } = await onboard(apiUrl, "Eve", { sync: CHATS });
    const asking = call(`${gatewayUrl}/v1/ask?format=json`, { key, body: { message: "Find me trading signals on CARSEM for MIN", forceOutcome: "win" } });
    assert.equal((await approvePending(apiUrl, key)).status, 201);
    const { status, body } = await asking;
    assert.equal(status, 200);
    assert.equal(body.brain, "scripted");
    assert.match(body.summary, /Repaid/);
    assert.equal(ctx.lending.list({})[0].status, "repaid");
    const calls = body.events.filter((e: { type: string }) => e.type === "tool_call").map((e: { tool: string }) => e.tool);
    assert.deepEqual(calls.slice(0, 6), ["carsem_status", "search_data", "buy_data", "borrow", "borrow_status", "buy_data"]);
    // The prompt itself became one of the user's past messages.
    assert.ok((await call(`${apiUrl}/me/messages`, { key })).body.messages.some((m: { source: string }) => m.source === "tool_queries"));
    // Every tool call is in the user's activity feed (for the dashboard).
    const activity = (await call(`${gatewayUrl}/v1/activity`, { key })).body;
    assert.ok(activity.some((a: { type: string; tool?: string }) => a.type === "tool_call" && a.tool === "borrow"));
  });

  it("POST /v1/tools/:name runs one tool", async () => {
    const { apiUrl, gatewayUrl } = await startStack();
    const { key } = await onboard(apiUrl, "Finn");
    const { body } = await call(`${gatewayUrl}/v1/tools/search_data`, { key, body: { category: "product", query: "pokemon" } });
    assert.ok(body.results.some((r: { title: string }) => r.title.includes("Pokemon")));
    assert.equal((await call(`${gatewayUrl}/v1/tools/search_data`, { key, body: { category: "cars" } })).status, 400);
  });
});

describe("default: published for every user, keeps selling", () => {
  it("loss → top-up request → deadline → published → users and enterprises keep buying", async () => {
    const { apiUrl, gatewayUrl, ctx } = await startStack({ loanDeadlineMs: 1500 });
    const alice = await onboard(apiUrl, "Alice", { sync: CHATS });
    const asking = call(`${gatewayUrl}/v1/ask?format=json`, { key: alice.key, body: { message: "Trade MIN for me", forceOutcome: "loss" } });
    await approvePending(apiUrl, alice.key);
    const { body: ask } = await asking;
    assert.match(ask.notifications[0], /published on CARSEM/);
    let [loan] = ctx.lending.list({});
    assert.equal(loan.status, "open");

    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.deepEqual(ctx.lending.checkDefaults(), [loan.id]);
    const bob = await onboard(apiUrl, "Bob");
    await fetch(`${apiUrl}/sim/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: bob.profile.agent.address, usdm: "2" }) });
    const { tool } = await mcp(gatewayUrl, bob.key);
    const published = await tool("browse_published_data");
    assert.equal(published.published.length, 1);
    const access = await tool("access_published_data", { bundle_id: published.published[0].bundle_id });
    assert.equal(access.status, "accessed");
    assert.ok(access.bundle.messages.every((m: string) => !m.includes("30th Sept")));
    assert.equal((await tool("access_published_data", { bundle_id: published.published[0].bundle_id })).http, 409);
    // The owner cannot buy their own data.
    assert.equal((await call(`${apiUrl}/market/bundles/${published.published[0].bundle_id}/access`, { method: "POST", key: alice.key })).status, 409);

    [loan] = ctx.lending.list({});
    assert.equal(loan.outstanding, "4.1");
    const amazon = await call(`${gatewayUrl}/enterprises/Amazon/buy`, { body: { bundleId: published.published[0].bundle_id } });
    assert.equal(amazon.status, 200, JSON.stringify(amazon.body));
    [loan] = ctx.lending.list({});
    assert.equal(loan.outstanding, "0");
    assert.ok(loan.events.some(e => e.kind === "debt_recovered"));
    // Still published: it keeps selling after the debt is covered; the surplus goes to the platform.
    const after = (await call(`${apiUrl}/market/bundles`)).body;
    assert.equal(after[0].status, "published");
    const sales = (await call(`${apiUrl}/market/sales`)).body;
    assert.ok(sales.some((s: { channel: string; toPlatform: string }) => s.channel === "enterprise" && s.toPlatform === "20.9"));
  });

  it("a private enterprise sale while the loan is open repays it and pays the owner", async () => {
    const { apiUrl, gatewayUrl, ctx } = await startStack();
    const alice = await onboard(apiUrl, "Alice", { sync: CHATS });
    const ids = (await call(`${apiUrl}/me/messages`, { key: alice.key })).body.messages.slice(0, 3).map((m: { id: number }) => m.id);
    assert.equal((await call(`${gatewayUrl}/v1/tools/borrow`, { key: alice.key, body: { amount_usdm: "5", message_ids: ids } })).body.status, "borrowed");
    const [bundle] = (await call(`${apiUrl}/market/bundles`)).body;
    assert.equal(bundle.status, "pledged");
    assert.equal(bundle.publicAccess, null);
    assert.equal((await call(`${gatewayUrl}/enterprises/eBay/buy`, { body: { bundleId: bundle.id } })).status, 200);
    const [loan] = ctx.lending.list({});
    assert.equal(loan.status, "repaid");
    assert.equal((await call(`${apiUrl}/me`, { key: alice.key })).body.earnings, "44.9");
  });
});

describe("x402 and Masumi", () => {
  it("charges once per payment and never reuses it for another listing", async () => {
    const { apiUrl, config } = await startStack();
    const { key, profile } = await onboard(apiUrl, "Gus");
    const buyer = new SimWallet("e2e-direct-buyer");
    await fetch(`${apiUrl}/sim/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: buyer.address, usdm: "10", ada: "10" }) });
    const wallet = simWallet(apiUrl, "e2e-direct-buyer");
    const http = new x402HTTPClient(x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new ExactCardanoScheme(wallet.signer) }],
      spendControls: { allowedAssets: [{ network: NETWORK, asset: config.usdmAsset, maxAmountPerPayment: "5000000" }] },
    }));
    const auth = { Authorization: `Bearer ${key}` };
    const first = await fetch(`${apiUrl}/data/listings/sig_min_09`, { headers: auth });
    assert.equal(first.status, 402);
    const offer = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!).accepts[0];
    assert.equal(offer.amount, "5000000");
    assert.equal(offer.network, NETWORK);
    const payload = await http.createPaymentPayload(http.getPaymentRequiredResponse(name => first.headers.get(name)));
    const headers = { ...auth, ...http.encodePaymentSignatureHeader(payload) };
    const paid = await fetch(`${apiUrl}/data/listings/sig_min_09`, { headers });
    assert.equal(paid.status, 200);
    const again = await fetch(`${apiUrl}/data/listings/sig_min_09`, { headers });
    assert.equal((await again.json() as any).delivery.hash, (await paid.json() as any).delivery.hash);
    assert.notEqual((await fetch(`${apiUrl}/data/listings/sig_snek_09`, { headers })).status, 200);
    assert.equal((await wallet.balances())[config.usdmAsset], toUnits("5"));
    assert.ok(profile.agent);
  });

  it("serves a MIP-003 job paid over x402", async () => {
    const { apiUrl, config } = await startStack();
    assert.equal((await call(`${apiUrl}/availability`)).body.status, "available");
    const { body: job } = await call(`${apiUrl}/start_job`, { body: { input_data: [{ key: "category", value: "flight" }, { key: "query", value: "KUL-SIN" }] } });
    const buyer = new SimWallet("e2e-masumi-buyer");
    await fetch(`${apiUrl}/sim/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: buyer.address, usdm: "1", ada: "5" }) });
    const paid = await paidFetch<any>(job.payment.url, { wallet: simWallet(apiUrl, "e2e-masumi-buyer"), asset: config.usdmAsset, maxAmount: toUnits("1") });
    assert.equal(paid.status, 200);
    const { body: status } = await call(`${apiUrl}/status?job_id=${job.job_id}`);
    assert.equal(status.status, "completed");
    assert.equal(status.result_hash, paid.body.delivery.hash);
  });
});

describe("redaction", () => {
  it("turns personal chats into intent signals", () => {
    const out = redactMessage("My girlfriend's birthday on 30th Sept");
    assert.equal(out.redacted, "[PERSON] birthday on [DATE]");
    assert.deepEqual(out.intents, ["birthday gift — budget intent"]);
    assert.equal(redactMessage("Email bob@example.com or call +60 12-345 6789").redacted, "Email [EMAIL] or call [PHONE]");
    assert.equal(redactMessage("I was diagnosed last week").withheld, "health");
  });

  it("removes people but keeps places and products, which is what the data is worth", () => {
    assert.equal(redactMessage("Cheapest flight from Kuala Lumpur to Singapore").redacted, "Cheapest flight from Kuala Lumpur to Singapore");
    assert.equal(redactMessage("Cheapest Pokemon Pack 30th Anniversary").redacted, "Cheapest Pokemon Pack 30th Anniversary");
    assert.equal(redactMessage("Call Sarah at +60 12-345 6789").redacted, "Call [NAME] at [PHONE]");
    assert.equal(redactMessage("Trip to Bali with my wife Sarah").redacted, "Trip to Bali with [PERSON]");
    assert.equal(redactMessage("Dinner with Ahmad and Mei").redacted, "Dinner with [NAME] and [NAME]");
  });
});

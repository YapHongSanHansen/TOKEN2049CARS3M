/**
 * End-to-end on the simulated chain: real HTTP, real x402 SDK on both sides,
 * real carsem-api, the agent's own tools and scripted brain.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { NETWORK, toUnits } from "@carsem/shared";
import { runAgent } from "../agent/src/brain.js";
import type { AgentConfig } from "../agent/src/config.js";
import { AgentTools, type AgentEvent } from "../agent/src/tools.js";
import { simWallet } from "../agent/src/wallet.js";
import { paidFetch } from "../agent/src/x402Client.js";
import { createApp } from "../carsem-api/src/app.js";
import { loadConfig, type Config } from "../carsem-api/src/config.js";
import { Db } from "../carsem-api/src/db.js";
import { DEMO_USER, seedDemo } from "../carsem-api/src/demo.js";
import { redactMessage } from "../carsem-api/src/services/redaction.js";

const stacks: Array<() => void> = [];
after(() => stacks.forEach(close => close()));

async function startStack(overrides: Partial<Config> = {}) {
  const config: Config = { ...loadConfig({ CHAIN_MODE: "simulated", DB_PATH: ":memory:", DEX_SIM_OUTCOME: "auto" }), ...overrides };
  const db = new Db(":memory:");
  seedDemo(db, config, { agentId: "agent-demo" });
  const { app, ctx } = await createApp(config, { db });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicUrl = url; // links the API hands out must point at this test server
  const agentConfig: AgentConfig = {
    mode: "simulated", apiUrl: url, agentId: "agent-demo", agentKey: config.demoAgentKey, maxPayment: toUnits("60"), tradeSizeAda: 400,
    port: 0, anthropicConfigured: false, model: "", sim: { agentSeed: config.sim.agentSeed }, preprod: { mnemonic: "", blockfrost: { baseUrl: "", projectId: "" } },
  };
  const wallet = simWallet(url, config.sim.agentSeed);
  const close = () => { server.close(); db.close(); };
  stacks.push(close);
  const events: AgentEvent[] = [];
  return { config, ctx, url, agentConfig, wallet, events, emit: (e: AgentEvent) => { events.push(e); } };
}

const json = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() as any };
};

describe("x402 paywall", () => {
  it("answers an unpaid signal request with a v2 Cardano offer", async () => {
    const { url, ctx, config } = await startStack();
    const response = await fetch(`${url}/signals/latest?token=MIN`);
    assert.equal(response.status, 402);
    const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!);
    assert.equal(required.x402Version, 2);
    const [offer] = required.accepts;
    assert.equal(offer.scheme, "exact");
    assert.equal(offer.network, NETWORK);
    assert.equal(offer.amount, "5000000");
    assert.equal(offer.asset, config.usdmAsset);
    assert.equal(offer.payTo, ctx.chain.treasuryAddress);
  });

  it("rejects unknown tokens before asking for payment", async () => {
    const { url } = await startStack();
    assert.equal((await fetch(`${url}/signals/latest?token=NOPE`)).status, 404);
  });

  it("charges once per payment and refuses to reuse it for another resource", async () => {
    const { url, wallet, config } = await startStack();
    await fetch(`${url}/sim/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, usdm: "10" }) });
    const http = new x402HTTPClient(x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new ExactCardanoScheme(wallet.signer) }],
      spendControls: { allowedAssets: [{ network: NETWORK, asset: config.usdmAsset, maxAmountPerPayment: "5000000" }] },
    }));
    const first = await fetch(`${url}/signals/latest?token=MIN`);
    const payload = await http.createPaymentPayload(http.getPaymentRequiredResponse(name => first.headers.get(name)));
    const headers = http.encodePaymentSignatureHeader(payload);

    const paid = await fetch(`${url}/signals/latest?token=MIN`, { headers });
    assert.equal(paid.status, 200);
    const body = await paid.json() as any;
    // The same signed payment again: same response, not a second charge.
    const again = await fetch(`${url}/signals/latest?token=MIN`, { headers });
    assert.equal(again.status, 200);
    assert.equal((await again.json() as any).delivery.hash, body.delivery.hash);
    // ...and it cannot buy a different resource.
    const other = await fetch(`${url}/signals/latest?token=SNEK`, { headers });
    assert.notEqual(other.status, 200);

    const balances = await wallet.balances();
    assert.equal(balances[config.usdmAsset], toUnits("10.05") - toUnits("5"));
  });
});

describe("agent loop", () => {
  it("green path: 402 -> borrow -> pay -> trade -> repay -> collateral released", async () => {
    const { agentConfig, wallet, emit, events, ctx } = await startStack();
    const result = await runAgent("Get me a trading signal for MIN and trade it", { config: agentConfig, wallet, emit, brain: "scripted", forceOutcome: "win" });
    const calls = events.filter(e => e.type === "tool_call").map(e => (e as { tool: string }).tool);
    assert.deepEqual(calls, ["check_balance", "get_signal", "borrow", "get_signal", "execute_trade", "loan_status", "check_balance", "repay"]);
    assert.match(result.summary, /Repaid loan/);

    const [loan] = ctx.lending.list({ agentId: "agent-demo" });
    assert.equal(loan.status, "repaid");
    assert.equal(loan.outstanding, "0");
    assert.deepEqual(loan.events.map(e => e.kind), ["disbursed", "repayment", "collateral_released"]);
    assert.equal(ctx.users.consent(DEMO_USER).bundle?.status, "held");

    const delivery = ctx.db.get<{ id: string }>("SELECT id FROM deliveries")!;
    await new Promise(resolve => setTimeout(resolve, 50));
    const view = ctx.signals.deliveryView(ctx.signals.delivery(delivery.id));
    assert.equal(view.decisionLog.status, "confirmed");
    assert.match(view.deliveryHash, /^[0-9a-f]{64}$/);
  });

  it("red path: loss -> asks for top-up -> deadline -> default -> bundle listed -> enterprise buys it", async () => {
    const { agentConfig, wallet, emit, ctx, url } = await startStack({ loanDeadlineMs: 1500 });
    const result = await runAgent("Trade MIN for me", { config: agentConfig, wallet, emit, brain: "scripted", forceOutcome: "loss" });
    assert.equal(result.notifications.length, 1);
    assert.match(result.notifications[0], /Top me up/);
    let [loan] = ctx.lending.list({ agentId: "agent-demo" });
    assert.equal(loan.status, "open");

    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.deepEqual(ctx.lending.checkDefaults(), [loan.id]);
    [loan] = ctx.lending.list({ agentId: "agent-demo" });
    assert.equal(loan.status, "defaulted");

    const { body: listings } = await json(`${url}/market/bundles`);
    assert.equal(listings.length, 1);
    assert.equal(listings[0].status, "listed");
    // Repaying a defaulted loan is refused before any payment is requested.
    assert.equal((await fetch(`${url}/loans/${loan.id}/repay`, { method: "POST" })).status, 409);

    const buyer = simWallet(url, "enterprise-amazon");
    const purchase = await paidFetch<any>(`${url}/market/bundles/${listings[0].id}/buy?bid=bid_amazon`, { method: "POST", wallet: buyer, asset: ctx.config.usdmAsset, maxAmount: toUnits("25") });
    assert.equal(purchase.status, 200);
    assert.ok(purchase.body.bundle.messages.length > 0);
    assert.ok(purchase.body.bundle.messages.every((m: string) => !m.includes("Sarah") && !m.includes("+60")));
    // The sale covers the 5.1 debt, the bundle comes off the market, the surplus goes to the owner.
    [loan] = ctx.lending.list({ agentId: "agent-demo" });
    assert.equal(loan.status, "defaulted");
    assert.equal(loan.outstanding, "0");
    assert.deepEqual(loan.events.map(e => e.kind), ["disbursed", "defaulted", "recovery_sale", "debt_recovered", "collateral_released"]);
    assert.equal((await json(`${url}/users/${DEMO_USER}`)).body.earnings, "19.9");
    assert.deepEqual((await json(`${url}/market/bundles`)).body, []);
  });

  it("rescue: loss -> user tops up -> 'repay my loan' repays in full", async () => {
    const { agentConfig, wallet, emit, ctx, url } = await startStack();
    await runAgent("Trade MIN for me", { config: agentConfig, wallet, emit, brain: "scripted", forceOutcome: "loss" });
    const early = await runAgent("Repay my loan", { config: agentConfig, wallet, emit, brain: "scripted" });
    assert.match(early.summary, /still missing/);
    await fetch(`${url}/sim/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, usdm: "5.05" }) });
    const result = await runAgent("Repay my loan", { config: agentConfig, wallet, emit, brain: "scripted" });
    assert.match(result.summary, /Repaid loan/);
    const [loan] = ctx.lending.list({ agentId: "agent-demo" });
    assert.equal(loan.status, "repaid");
  });

  it("an enterprise purchase while the loan is open repays it and credits the data owner", async () => {
    const { agentConfig, wallet, emit, ctx, url } = await startStack();
    const tools = new AgentTools(agentConfig, wallet, emit);
    const loan = await tools.borrow({ amount_usdm: "5" });
    assert.ok(!("error" in loan));

    const { body: listings } = await json(`${url}/market/bundles`);
    assert.equal(listings[0].status, "pledged");
    const buyer = simWallet(url, "enterprise-ebay");
    const purchase = await paidFetch<any>(`${url}/market/bundles/${listings[0].id}/buy?bid=ebay`, { method: "POST", wallet: buyer, asset: ctx.config.usdmAsset, maxAmount: toUnits("50") });
    assert.equal(purchase.status, 200);

    const view = ctx.lending.view(ctx.lending.get(loan.loan_id));
    assert.equal(view.status, "repaid");
    assert.deepEqual(view.events.map(e => e.kind), ["disbursed", "bundle_sale", "collateral_released"]);
    const { body: user } = await json(`${url}/users/${DEMO_USER}`);
    assert.equal(user.earnings, "44.9");
  });
});

describe("lending rules", () => {
  it("needs the agent key, the owner's consent, and one loan at a time", async () => {
    const { url, agentConfig, wallet, emit } = await startStack();
    const post = (body: unknown, key = agentConfig.agentKey) => json(`${url}/loans`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    assert.equal((await post({ agentId: "agent-demo", amount: "5" }, "wrong")).status, 401);
    assert.equal((await post({ agentId: "agent-demo", amount: "50" })).status, 400);

    const tools = new AgentTools(agentConfig, wallet, emit);
    assert.ok(!("error" in await tools.borrow({ amount_usdm: "5" })));
    assert.equal((await post({ agentId: "agent-demo", amount: "1" })).status, 409);
    assert.equal((await json(`${url}/users/${DEMO_USER}/consent`, { method: "DELETE" })).status, 409);
  });

  it("refuses to lend once the owner revokes consent", async () => {
    const { url, agentConfig, wallet, emit } = await startStack();
    assert.equal((await json(`${url}/users/${DEMO_USER}/consent`, { method: "DELETE" })).body.status, "revoked");
    const result = await new AgentTools(agentConfig, wallet, emit).borrow({ amount_usdm: "5" });
    assert.ok("error" in result && result.status === 403);
  });
});

describe("Masumi agentic service API", () => {
  it("runs a job: start_job -> pay over x402 -> status completed with the result hash", async () => {
    const { url, wallet, ctx } = await startStack();
    assert.equal((await json(`${url}/availability`)).body.status, "available");
    await fetch(`${url}/sim/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, usdm: "5" }) });
    const { body: job } = await json(`${url}/start_job`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input_data: [{ key: "token", value: "SNEK" }] }) });
    assert.equal((await json(`${url}/status?job_id=${job.job_id}`)).body.status, "awaiting_payment");
    const paid = await paidFetch<any>(job.payment.url, { wallet, asset: ctx.config.usdmAsset, maxAmount: toUnits("5") });
    assert.equal(paid.status, 200);
    const { body: status } = await json(`${url}/status?job_id=${job.job_id}`);
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
});

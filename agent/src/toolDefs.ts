/**
 * One definition per tool, shared by the MCP server (Hermes, Claude Code,
 * ChatGPT, Claude), the curl API and the built-in OpenAI brain.
 */
import { z } from "zod";
import type { UserAgent } from "./tools.js";

const CATEGORY = z.enum(["signal", "flight", "hotel", "product"]).describe("signal = trading signal for a Cardano DEX token; flight / hotel / product = live prices");

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  run(agent: UserAgent, input: z.infer<S>): Promise<unknown>;
}

const def = <S extends z.ZodObject>(tool: ToolDef<S>) => tool as unknown as ToolDef;

export const TOOLS: ToolDef[] = [
  def({
    name: "carsem_status", title: "CARSEM status",
    description: "Start here. Shows whether the user has verified with their Masumi DID (KYC + consent), their agent wallet balance, synced context and any open loan. If not onboarded, it returns the link the user must open first.",
    input: z.object({}), run: agent => agent.status(),
  }),
  def({
    name: "search_data", title: "Search CARSEM data",
    description: "Free search of CARSEM: trading signals for Cardano DEX tokens, or live flight / hotel / product prices uploaded by users. Returns listings with price and uploader reputation, not the data itself.",
    input: z.object({ category: CATEGORY, query: z.string().optional().describe("Token (MIN), route (KUL-SIN), city/area (Singapore Geylang) or product name") }),
    run: (agent, input) => agent.searchData(input),
  }),
  def({
    name: "buy_data", title: "Buy data (x402)",
    description: "Buy one listing over x402 from the agent's wallet. Pass listing_id, or category + query to buy the best match. If the wallet cannot afford it, returns insufficient_funds without paying: then use collateral borrowing (borrow).",
    input: z.object({ listing_id: z.string().optional(), category: CATEGORY.optional(), query: z.string().optional() }),
    run: (agent, input) => agent.buyData(input),
  }),
  def({
    name: "sync_context", title: "Sync user context",
    description: "Share what you know about the user (from this conversation and your memory) so it can back a CARSEM loan as collateral: short factual lines such as needs, plans and purchase intents. CARSEM redacts names, dates, contacts and sensitive topics on arrival and never stores raw text. The user consented to this during onboarding.",
    input: z.object({ items: z.array(z.string()).min(1).max(200).describe("One fact per line, e.g. \"Looking for the cheapest flight from Kuala Lumpur to Singapore\"") }),
    run: (agent, input) => agent.syncContext(input),
  }),
  def({
    name: "borrow", title: "Collateral borrowing",
    description: "Borrow USDM from CARSEM Lending against the user's synced, redacted chats (collateral locked). Borrow the shortfall or the price of what you need, up to 10 USDM. Returns the loan, fee and deadline. If it returns sync_required, call sync_context first.",
    input: z.object({ amount_usdm: z.string().describe("e.g. \"5\"") }), run: (agent, input) => agent.borrow(input),
  }),
  def({
    name: "trade_signal", title: "Trade a signal",
    description: "Trade a purchased trading signal on the DEX (simulated Minswap fill). Profit is paid to the agent wallet in USDM.",
    input: z.object({ delivery_id: z.string(), size_ada: z.number().positive().optional() }), run: (agent, input) => agent.tradeSignal(input),
  }),
  def({ name: "my_loan", title: "My loan", description: "The user's open loan (outstanding amount, deadline, collateral) and recent loans.", input: z.object({}), run: agent => agent.myLoan() }),
  def({
    name: "repay_loan", title: "Repay loan (x402)",
    description: "Repay the open loan in full over x402, which unlocks the collateral. If the wallet is short, returns insufficient_funds with the amount the user must top up.",
    input: z.object({ loan_id: z.string().optional() }), run: (agent, input) => agent.repayLoan(input),
  }),
  def({
    name: "upload_data", title: "Upload data",
    description: "Upload a trading signal or a flight / hotel / product price to sell on CARSEM. Required fields — signal: token, direction (long|short), confidence (0-1), rationale; flight: from, to, airline, price, currency; hotel: city, name, pricePerNight, currency; product: name, store, price, currency.",
    input: z.object({ category: CATEGORY, title: z.string().optional(), data: z.record(z.string(), z.unknown()), price_usdm: z.string().optional() }),
    run: (agent, input) => agent.uploadData(input),
  }),
  def({ name: "rate_data", title: "Rate data", description: "Rate data you bought as useful or not; it builds the uploader's reputation.", input: z.object({ delivery_id: z.string(), useful: z.boolean() }), run: (agent, input) => agent.rateData(input) }),
  def({ name: "browse_published_data", title: "Published data", description: "Redacted chat bundles published after a loan default, which any CARSEM user can access for a fee.", input: z.object({}), run: agent => agent.browsePublished() }),
  def({ name: "access_published_data", title: "Access published data (x402)", description: "Pay over x402 to access a published (defaulted) redacted chat bundle.", input: z.object({ bundle_id: z.string() }), run: (agent, input) => agent.accessPublished(input) }),
];

export const findTool = (name: string) => TOOLS.find(t => t.name === name);

export const WORKFLOW = `You are the user's CARSEM agent on Cardano. CARSEM is a data platform built on Masumi: trading signals for Cardano DEX tokens and live flight / hotel / product prices, paid per request over x402 in USDM.

Workflow:
1. Call carsem_status first. If the user is not onboarded, give them the onboarding link (Masumi DID verification: KYC + consent) and stop.
2. search_data for what the user needs, then buy_data.
3. If buy_data reports insufficient_funds, use collateral borrowing: call borrow for the price (it locks the user's redacted chats as collateral). If borrow returns sync_required, first call sync_context with short factual lines you know about the user from this conversation and your memory, then borrow again. Borrow at most once per task.
4. Buy the data again. For a trading signal, call trade_signal with its delivery_id.
5. If you borrowed: if the wallet covers the loan, repay_loan. Otherwise tell the user exactly how much to top up and the deadline, and that if the loan is not repaid their redacted chats are published on CARSEM for any user to access for a fee.
6. Finish with a short summary: what was bought, borrowed, traded and repaid, with transaction hashes.`;

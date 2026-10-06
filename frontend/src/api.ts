/** carsem-api is proxied at /api, the agent service at /agent (see vite.config.ts). */

export const DEMO_USER = "usr_demo";
export const DEMO_AGENT = "agent-demo";

export interface Health { status: string; mode: "simulated" | "preprod"; network: string; facilitator: string; treasury: string; usdmAsset: string; signalPrice: string; l1Confirmations: number }
export interface TxRef { hash: string; explorerUrl: string }
export interface LoanEvent { kind: string; amount: string | null; at: string; tx: TxRef | null; enterprise?: string }
export interface Loan {
  id: string; agentId: string; userId: string; status: "disbursing" | "open" | "repaid" | "defaulted";
  amount: string; fee: string; repaid: string; outstanding: string; totalDue: string; deadline: string | null; secondsLeft: number | null;
  collateralRef: string; bundleId: string; disburseTx: TxRef | null; createdAt: string; closedAt: string | null; events: LoanEvent[];
}
export interface AgentWallet { agentId: string; address: string; mode: string; tUSDM: string; tADA: string }
export interface Consent {
  userId: string; status: "active" | "revoked" | "none"; agentId?: string | null; allowSaleWhileOpen?: boolean; grantedAt?: string; revokedAt?: string | null;
  bundle?: { id: string; status: "held" | "pledged" | "listed" | "revoked"; collateralRef: string; preview: string[]; stats: BundleStats };
}
export interface BundleStats { messages: number; withheld: number; replacements: Record<string, number>; intents: Record<string, number> }
export interface User { id: string; name: string; earnings: string; consent: Consent }
export interface Listing {
  id: string; status: "pledged" | "listed"; reason: string; collateralRef: string; stats: BundleStats; preview: string[];
  loan?: { id: string; status: string; outstanding: string }; offers: Array<{ bidId: string; enterprise: string; price: number }>; soldTo: string[];
}
export interface Bid { id: string; enterprise: string; priceUsdm: number; dataAmount: number }
export interface Sale { id: string; bundleId: string; bidId: string; enterprise: string; buyer: string | null; price: string; paymentTx: string; loanId: string | null; appliedToLoan: string; toUser: string; at: string }
export interface Uploader { id: string; name: string; reputation: number; hits: number; misses: number; signals: number }
export interface Activity { at: string; type: string; tx: TxRef | null; [key: string]: unknown }
export interface EnterpriseWallet { enterprise: string; address: string; tUSDM: string; tADA: string }

export type AgentEvent = { at: string } & (
  | { type: "run_started"; message: string; brain: string }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; result: any }
  | { type: "x402"; tool: string; step: "request" | "offer" | "signed" | "paid" | "pending" | "settled" | "rejected"; detail: Record<string, any> }
  | { type: "notify_user"; message: string }
  | { type: "run_finished"; summary: string }
  | { type: "error"; message: string }
);

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* plain text */ }
  if (!response.ok) throw new RequestError(response.status, body?.error ?? `HTTP ${response.status}`);
  return body as T;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

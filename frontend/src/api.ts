/** carsem-api is proxied at /api, the agent gateway at /agent (see vite.config.ts). */

export interface Health {
  status: string; mode: "simulated" | "preprod"; network: string; facilitator: string; treasury: string; usdmAsset: string;
  prices: Record<string, string>; publicAccessPrice: string; kyc: string; issuer: string; gateway: string; l1Confirmations: number;
}
export interface TxRef { hash: string; explorerUrl: string }
export interface Profile {
  id: string; name: string; onboarded: boolean;
  steps: { wallet: string; kyc: string; consent: string; agent: boolean };
  wallet: { name: string | null; id: string; payoutAddress: string | null; proof: string; verifiedAt: string; explorerUrl: string };
  kyc: { status: string; provider: string; verifiedAt: string | null };
  identity: { did: string; didDocument: string; credential: { jwt: string; revoked: boolean; issuer: string } } | null;
  agent: { id: string; name: string; did: string; address: string; masumi: { registered: boolean; agentIdentifier?: string; note?: string }; explorerUrl: string } | null;
  consent: { status: string; allowBorrowing?: boolean; allowSaleWhileOpen?: boolean; sources?: string[]; grantedAt?: string };
  earnings: string;
  connect: { gateway: string; mcp: string; onboarding: string };
}
export interface LoanEvent { kind: string; amount: string | null; at: string; tx: TxRef | null }
export interface Loan {
  id: string; agentId: string; userId: string; status: "disbursing" | "open" | "repaid" | "defaulted";
  amount: string; fee: string; repaid: string; outstanding: string; totalDue: string; deadline: string | null; secondsLeft: number | null;
  collateral: { ref: string; bundleId: string; version?: number; items?: number; status?: string };
  disburseTx: TxRef | null; createdAt: string; closedAt: string | null; events: LoanEvent[];
}
export interface PastMessage { id: number; source: string; text: string; intents: string[]; at: string; state: string | null }
export interface MessagesState { messages: PastMessage[]; minimumToPledge: number; canBorrow: boolean; bySource: Record<string, number>; lastAddedAt: string | null }
export interface LoanRequest { id: string; status: string; amount: string; purpose: string; loanId: string | null; createdAt: string; minMessagesToPledge: number }
export interface AgentStatus {
  onboarded: boolean; next?: string;
  wallet?: { address: string; USDM: string; tADA: string };
  pastMessages?: { count: number; canBorrow: boolean; minimumToPledge: number };
  openLoan?: { loan_id: string; outstanding_usdm: string; deadline: string; seconds_left: number } | null;
}
export interface ActivityEntry { id: number; at: string; type: string; tool?: string; data: any }
export interface Listing {
  id: string; status: "pledged" | "published"; reason: string; collateralRef: string;
  stats: { messages: number; withheld: number; intents: Record<string, number>; sources?: string[] }; preview: string[];
  loan?: { id: string; status: string; outstanding: string };
  enterpriseOffers: Array<{ bidId: string; enterprise: string; price: number }>; soldTo: string[];
  publicAccess: { price: string; buyers: number; accessUrl: string; youOwnIt: boolean; isYours: boolean } | null;
}
export interface Sale { id: string; bundleId: string; channel: string; enterprise: string | null; buyerUserId: string | null; price: string; paymentTx: string; loanId: string | null; appliedToLoan: string; toUser: string; toPlatform: string; at: string }
export interface MarketItem {
  id: string; category: "signal" | "flight" | "hotel"; title: string; price: string; free: boolean; unlocked: boolean;
  data: Record<string, unknown> | null; uploadedAt: string; uploader: { id: string; name: string; address: string | null; reputation: number };
}
export interface Uploader { id: string; name: string; reputation: number; hits: number; misses: number; listings: number }
export interface Category { category: string; price: string; listings: number }
export interface Activity { at: string; type: string; tx: TxRef | null; [key: string]: unknown }
export interface EnterpriseWallet { enterprise: string; address: string; tUSDM: string; tADA: string }

const KEY = "carsem.key";
export const storedKey = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
export const saveKey = (key: string) => { try { if (key) localStorage.setItem(KEY, key); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

export class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}, withKey = true): Promise<T> {
  const key = storedKey();
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (withKey && key) headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* plain text */ }
  if (!response.ok) throw new RequestError(response.status, body?.error ?? `HTTP ${response.status}`, body?.code);
  return body as T;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

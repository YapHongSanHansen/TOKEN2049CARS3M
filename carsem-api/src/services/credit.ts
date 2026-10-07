/**
 * Credit score and credit limit, from what CARSEM can see about the user:
 *
 *   account age      up to 30 points  how long this wallet has been around (first on-chain activity on
 *                                     preprod when Blockfrost is configured, else the CARSEM account)
 *   chat history     up to 40 points  how many past messages back the account (the collateral pool)
 *   variety          up to 20 points  different sources and intents in that history
 *   repayment        -10 .. +10       loans repaid on time add, defaults subtract
 *
 * The limit grows linearly with the score: 1 USDM at 0, 50 USDM at 100. A loan can't exceed it.
 */
import { fromUnits, toUnits } from "@carsem/shared";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { UserRow } from "./users.js";

const DAY = 86_400_000;
export const CREDIT_MIN_USDM = 1;
export const CREDIT_MAX_USDM = 50;

export interface CreditFactor { points: number; max: number; detail: string }
export interface CreditView {
  score: number;
  limitUsdm: string;
  limitUnits: string;
  factors: { accountAge: CreditFactor; history: CreditFactor; variety: CreditFactor; repayment: CreditFactor };
  /** What would raise the score next. */
  next: string[];
}

export class Credit {
  /** First on-chain activity per wallet id, looked up once per process (preprod only). */
  private readonly firstSeen = new Map<string, Promise<number | null>>();

  constructor(private readonly db: Db, private readonly config: Config) {}

  /** The user's credit, synchronous: uses the CARSEM account age plus any wallet age already looked up. */
  view(user: UserRow): CreditView {
    const walletFirst = this.firstSeenCache.get(user.wallet_id);
    const since = walletFirst && walletFirst < user.created_at ? walletFirst : user.created_at;
    const ageDays = Math.max(0, (Date.now() - since) / DAY);
    // 30 points at one year, with a quick start: a month is worth 10.
    const agePoints = Math.round(Math.min(30, 10 * Math.log10(1 + ageDays * 9 / 30 * 10) / Math.log10(1 + 365 * 9 / 30 * 10) * 3));

    const history = this.db.get<{ n: number; sources: number }>(
      "SELECT COUNT(*) AS n, COUNT(DISTINCT source) AS sources FROM sync_items WHERE user_id = ? AND withheld IS NULL", user.id)!;
    // 40 points at 200 messages.
    const historyPoints = Math.round(Math.min(40, 40 * Math.sqrt(Math.min(history.n, 200) / 200)));

    const intents = new Set<string>();
    for (const row of this.db.all<{ intents_json: string }>("SELECT intents_json FROM sync_items WHERE user_id = ? AND withheld IS NULL", user.id)) {
      try { for (const i of JSON.parse(row.intents_json) as string[]) intents.add(i); } catch { /* ignore */ }
    }
    const varietyPoints = Math.min(20, Math.min(history.sources, 3) * 4 + Math.min(intents.size, 4) * 2);

    const loans = this.db.get<{ repaid: number; defaulted: number }>(
      "SELECT SUM(status = 'repaid') AS repaid, SUM(status = 'defaulted') AS defaulted FROM loans WHERE user_id = ?", user.id) ?? { repaid: 0, defaulted: 0 };
    const repaymentPoints = Math.max(-10, Math.min(10, (loans.repaid ?? 0) * 3 - (loans.defaulted ?? 0) * 5));

    const score = Math.max(0, Math.min(100, agePoints + historyPoints + varietyPoints + repaymentPoints));
    const limit = CREDIT_MIN_USDM + (CREDIT_MAX_USDM - CREDIT_MIN_USDM) * score / 100;
    const limitUsdm = limit.toFixed(2);
    const next: string[] = [];
    if (historyPoints < 40) next.push(`add past messages (${history.n} now; 200 gives the full 40 points)`);
    if (varietyPoints < 20) next.push("bring history from more than one app and with more kinds of intent");
    if (repaymentPoints < 10) next.push("repay loans on time (+3 each)");
    if (agePoints < 30) next.push("account age counts up to a year");
    return {
      score, limitUsdm, limitUnits: toUnits(limitUsdm).toString(),
      factors: {
        accountAge: { points: agePoints, max: 30, detail: `${Math.floor(ageDays)} day(s)${walletFirst ? " (wallet first seen on chain)" : ""}` },
        history: { points: historyPoints, max: 40, detail: `${history.n} past message(s)` },
        variety: { points: varietyPoints, max: 20, detail: `${history.sources} source(s), ${intents.size} intent(s)` },
        repayment: { points: repaymentPoints, max: 10, detail: `${loans.repaid ?? 0} repaid, ${loans.defaulted ?? 0} defaulted` },
      },
      next,
    };
  }

  limitUnits(user: UserRow): bigint { return BigInt(this.view(user).limitUnits); }
  formatLimit(user: UserRow): string { return fromUnits(this.limitUnits(user)); }

  private readonly firstSeenCache = new Map<string, number>();

  /** Looks up the wallet's first on-chain activity (preprod, Blockfrost) and caches it for `view()`. */
  async refreshWalletAge(user: UserRow): Promise<void> {
    if (this.config.mode !== "preprod" || !this.config.preprod.blockfrost.projectId || this.firstSeenCache.has(user.wallet_id)) return;
    if (!this.firstSeen.has(user.wallet_id)) {
      const { baseUrl, projectId } = this.config.preprod.blockfrost;
      const path = user.wallet_id.startsWith("stake") ? `/accounts/${user.wallet_id}/addresses` : null;
      this.firstSeen.set(user.wallet_id, (async () => {
        try {
          // The oldest transaction of the first address under the account (or of the address itself).
          const address = path
            ? ((await (await fetch(`${baseUrl}${path}?count=1&order=asc`, { headers: { project_id: projectId } })).json()) as Array<{ address: string }>)[0]?.address
            : user.wallet_id;
          if (!address) return null;
          const txs = (await (await fetch(`${baseUrl}/addresses/${address}/transactions?count=1&order=asc`, { headers: { project_id: projectId } })).json()) as Array<{ block_time: number }>;
          return txs[0] ? txs[0].block_time * 1000 : null;
        } catch { return null; }
      })());
    }
    const first = await this.firstSeen.get(user.wallet_id)!;
    if (first) this.firstSeenCache.set(user.wallet_id, first);
  }
}

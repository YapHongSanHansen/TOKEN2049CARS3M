import { useState } from "react";
import { get, post, type Activity, type Category, type Loan, type Sale, type Uploader } from "../api";
import { Badge, Countdown, Empty, Panel, Stat, TxLink, loanTone, short } from "../components";
import { useHealth, usePoll } from "../hooks";

const ACTIVITY_LABEL: Record<string, string> = {
  "user.onboarded": "User verified (Masumi DID)", "loan.collateral_locked": "Collateral locked", "loan.disbursed": "Loan disbursed",
  "loan.repayment": "Loan repaid", "loan.enterprise_sale": "Enterprise sale applied to loan", "loan.collateral_released": "Collateral released",
  "loan.defaulted": "Loan defaulted → chats published", "loan.recovery_sale": "Sale of published chats", "loan.debt_recovered": "Debt recovered",
  "data.delivered": "Data sold (x402)", "dex.trade": "DEX trade", "market.enterprise_sale": "Enterprise bought a bundle", "market.public_sale": "User accessed published chats",
};

export function DashboardView() {
  const health = useHealth();
  const loans = usePoll(() => get<Loan[]>("/api/loans"), 3000);
  const uploaders = usePoll(() => get<Uploader[]>("/api/data/uploaders"), 5000);
  const categories = usePoll(() => get<Category[]>("/api/data/categories"), 10000);
  const activity = usePoll(() => get<Activity[]>("/api/activity"), 3000);
  const sales = usePoll(() => get<Sale[]>("/api/market/sales"), 5000);
  const treasury = usePoll(() => (health ? get<{ tUSDM: string; tADA: string }>(`/api/chain/balances/${health.treasury}`) : Promise.resolve(undefined)), 5000, [health?.treasury]);
  const [checking, setChecking] = useState(false);

  const all = loans.data ?? [];
  const sum = (values: string[]) => values.reduce((a, v) => a + Number(v), 0);
  const delivered = (activity.data ?? []).filter(a => a.type === "data.delivered").length;
  const users = (activity.data ?? []).filter(a => a.type === "user.onboarded").length;

  return (
    <div className="dashboard">
      <div className="stats">
        <Stat label="Treasury" value={treasury.data ? `${Number(treasury.data.tUSDM).toLocaleString()} USDM` : "…"} sub={treasury.data && `${Number(treasury.data.tADA).toLocaleString()} tADA`} />
        <Stat label="Verified users" value={users} sub="Masumi DID + KYC" tone="good" />
        <Stat label="Open loans" value={all.filter(l => l.status === "open").length} sub={`${sum(all.filter(l => l.status === "open").map(l => l.outstanding)).toFixed(2)} USDM outstanding`} tone="warn" />
        <Stat label="Defaults" value={all.filter(l => l.status === "defaulted").length} sub="chats published" tone="bad" />
        <Stat label="Data sold" value={delivered} sub="via x402" tone="x402" />
        <Stat label="Chat sales" value={`${sum((sales.data ?? []).map(s => s.price)).toFixed(2)} USDM`} sub={`${sales.data?.length ?? 0} sales`} />
      </div>

      <div className="dashboard-grid">
        <Panel title="Loans" actions={
          <button className="ghost" disabled={checking} onClick={async () => { setChecking(true); await post("/api/admin/check-defaults").catch(() => {}); await loans.refresh(); setChecking(false); }}>Enforce deadlines now</button>
        }>
          {all.length ? (
            <table>
              <thead><tr><th>Loan</th><th>Amount</th><th>Outstanding</th><th>Collateral</th><th>Deadline</th><th>Status</th><th>Disbursed</th></tr></thead>
              <tbody>
                {all.map(l => (
                  <tr key={l.id}>
                    <td><code>{l.id}</code></td><td>{l.amount}</td><td>{l.outstanding}</td><td>{l.collateral.items} items</td>
                    <td>{l.status === "open" && l.deadline ? <Countdown deadline={l.deadline} /> : <span className="muted">—</span>}</td>
                    <td><Badge tone={loanTone(l.status)}>{l.status}</Badge></td>
                    <td>{l.disburseTx && <TxLink hash={l.disburseTx.hash} url={l.disburseTx.explorerUrl} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No loans yet.</Empty>}
        </Panel>

        <Panel title="Data on CARSEM">
          <div className="category-row">
            {(categories.data ?? []).map(c => <div key={c.category} className="category"><strong>{c.listings}</strong><span>{c.category}s</span><span className="muted small">{c.price} USDM</span></div>)}
          </div>
          <table>
            <thead><tr><th>Uploader</th><th>Reputation</th><th>Hit / miss</th><th>Listings</th></tr></thead>
            <tbody>
              {(uploaders.data ?? []).slice(0, 8).map(u => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td><div className="rep"><div className="rep-bar"><div style={{ width: `${u.reputation * 100}%` }} /></div>{u.reputation.toFixed(2)}</div></td>
                  <td>{u.hits} / {u.misses}</td><td>{u.listings}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Uploaded data is not validated; reputation grows from trade outcomes and buyer ratings.</p>
        </Panel>

        <Panel title="Activity" className="span-2">
          {activity.data?.length ? (
            <ul className="feed">
              {activity.data.map((a, i) => (
                <li key={i}>
                  <time>{new Date(a.at).toLocaleTimeString()}</time>
                  <span className={`feed-type ${a.type.split(".")[0]}`}>{ACTIVITY_LABEL[a.type] ?? a.type}</span>
                  <span className="feed-detail">{describe(a)}</span>
                  {a.tx ? <TxLink hash={a.tx.hash} url={a.tx.explorerUrl} /> : <span />}
                </li>
              ))}
            </ul>
          ) : <Empty>Nothing yet.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

function describe(a: Activity) {
  if (a.type.startsWith("loan.")) return `${a.loanId as string}${a.amount ? ` · ${a.amount as string} USDM` : ""}`;
  if (a.type === "data.delivered") return `${a.title as string} → ${short(String(a.buyer ?? ""), 10, 4)} · proof ${short(String(a.deliveryHash), 8, 4)}`;
  if (a.type === "dex.trade") return `${a.outcome as string} ${a.pnl as string} USDM (simulated fill)`;
  if (a.type.startsWith("market.")) return `${a.bundleId as string} · ${a.price as string} USDM`;
  if (a.type === "user.onboarded") return `${a.name as string}`;
  return "";
}

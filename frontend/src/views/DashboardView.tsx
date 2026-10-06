import { useState } from "react";
import { get, post, type Activity, type Loan, type Sale, type Uploader } from "../api";
import { Badge, Countdown, Empty, Panel, Stat, TxLink, loanTone, short } from "../components";
import { useHealth, usePoll } from "../hooks";

const ACTIVITY_LABEL: Record<string, string> = {
  "loan.disbursed": "Loan disbursed", "loan.repayment": "Loan repaid", "loan.bundle_sale": "Bundle sale applied to loan",
  "loan.collateral_released": "Collateral released", "loan.defaulted": "Loan defaulted → bundle listed", "loan.recovery_sale": "Recovery sale",
  "loan.debt_recovered": "Debt recovered",
  "signal.delivered": "Signal sold", "dex.trade": "DEX trade", "market.sale": "Data bundle sold",
};

export function DashboardView() {
  const health = useHealth();
  const loans = usePoll(() => get<Loan[]>("/api/loans"), 3000);
  const uploaders = usePoll(() => get<Uploader[]>("/api/signals/uploaders"), 5000);
  const activity = usePoll(() => get<Activity[]>("/api/activity"), 3000);
  const sales = usePoll(() => get<Sale[]>("/api/market/sales"), 5000);
  const treasury = usePoll(() => (health ? get<{ tUSDM: string; tADA: string }>(`/api/chain/balances/${health.treasury}`) : Promise.resolve(undefined)), 5000, [health?.treasury]);
  const [checking, setChecking] = useState(false);

  const all = loans.data ?? [];
  const sum = (values: string[]) => values.reduce((a, v) => a + Number(v), 0);
  const signalsSold = (activity.data ?? []).filter(a => a.type === "signal.delivered").length;

  return (
    <div className="dashboard">
      <div className="stats">
        <Stat label="Treasury" value={treasury.data ? `${Number(treasury.data.tUSDM).toLocaleString()} tUSDM` : "…"} sub={treasury.data && `${Number(treasury.data.tADA).toLocaleString()} tADA`} />
        <Stat label="Open loans" value={all.filter(l => l.status === "open").length} sub={`${sum(all.filter(l => l.status === "open").map(l => l.outstanding)).toFixed(2)} tUSDM outstanding`} tone="warn" />
        <Stat label="Lent (all time)" value={`${sum(all.map(l => l.amount)).toFixed(2)} tUSDM`} sub={`${all.filter(l => l.status === "repaid").length} repaid`} tone="good" />
        <Stat label="Defaults" value={all.filter(l => l.status === "defaulted").length} sub="bundles listed" tone="bad" />
        <Stat label="Signals sold" value={signalsSold} sub="via x402" tone="x402" />
        <Stat label="Data sales" value={`${sum((sales.data ?? []).map(s => s.price)).toFixed(2)} tUSDM`} sub={`${sales.data?.length ?? 0} bundles`} />
      </div>

      <div className="dashboard-grid">
        <Panel title="Loans" actions={
          <button className="ghost" disabled={checking} onClick={async () => { setChecking(true); await post("/api/admin/check-defaults").catch(() => {}); await loans.refresh(); setChecking(false); }}>Enforce deadlines now</button>
        }>
          {all.length ? (
            <table>
              <thead><tr><th>Loan</th><th>Agent</th><th>Amount</th><th>Outstanding</th><th>Deadline</th><th>Status</th><th>Disbursed</th></tr></thead>
              <tbody>
                {all.map(l => (
                  <tr key={l.id}>
                    <td><code>{l.id}</code></td><td>{l.agentId}</td><td>{l.amount}</td><td>{l.outstanding}</td>
                    <td>{l.status === "open" && l.deadline ? <Countdown deadline={l.deadline} /> : <span className="muted">—</span>}</td>
                    <td><Badge tone={loanTone(l.status)}>{l.status}</Badge></td>
                    <td>{l.disburseTx && <TxLink hash={l.disburseTx.hash} url={l.disburseTx.explorerUrl} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No loans yet.</Empty>}
        </Panel>

        <Panel title="Signal uploaders">
          <table>
            <thead><tr><th>Uploader</th><th>Reputation</th><th>Hit / miss</th><th>Signals</th></tr></thead>
            <tbody>
              {(uploaders.data ?? []).map(u => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td><div className="rep"><div className="rep-bar"><div style={{ width: `${u.reputation * 100}%` }} /></div>{u.reputation.toFixed(2)}</div></td>
                  <td>{u.hits} / {u.misses}</td><td>{u.signals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Activity" className="span-2">
          {activity.data?.length ? (
            <ul className="feed">
              {activity.data.map((a, i) => (
                <li key={i}>
                  <time>{new Date(a.at).toLocaleTimeString()}</time>
                  <span className={`feed-type ${a.type.split(".")[0]}`}>{ACTIVITY_LABEL[a.type] ?? a.type}</span>
                  <span className="feed-detail">{describe(a)}</span>
                  {a.tx && <TxLink hash={a.tx.hash} url={a.tx.explorerUrl} />}
                </li>
              ))}
            </ul>
          ) : <Empty>Nothing yet. Run the agent.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

function describe(a: Activity) {
  if (a.type.startsWith("loan.")) return `${a.loanId as string}${a.amount ? ` · ${a.amount as string} tUSDM` : ""}`;
  if (a.type === "signal.delivered") return `${a.signalId as string} → ${short(String(a.buyer ?? ""), 10, 4)} · proof ${short(String(a.deliveryHash), 8, 4)}`;
  if (a.type === "dex.trade") return `${a.outcome as string} ${a.pnl as string} tUSDM (simulated fill)`;
  if (a.type === "market.sale") return `${a.bundleId as string} · ${a.price as string} tUSDM`;
  return "";
}

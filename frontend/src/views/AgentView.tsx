import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, post, type ActivityEntry, type AgentStatus, type Loan, type SyncState } from "../api";
import { AddressLink, Badge, Countdown, DeadlineBar, Empty, ErrorNote, JsonToggle, Panel, TxLink, loanTone, short } from "../components";
import { useHealth, usePoll, useSession } from "../hooks";

const TOOL_LABEL: Record<string, string> = {
  carsem_status: "Check status", search_data: "Search CARSEM", buy_data: "Buy data (x402)", sync_context: "Sync user context",
  borrow: "Collateral borrowing", trade_signal: "Trade on DEX", my_loan: "My loan", repay_loan: "Repay loan (x402)",
  upload_data: "Upload data", rate_data: "Rate data", browse_published_data: "Browse published data", access_published_data: "Access published data (x402)", notify_user: "Notify user",
};

export function AgentView() {
  const { key, profile } = useSession();
  if (!key || !profile?.onboarded) {
    return <div className="offline-note">Verify first: open <a href="#start">Get started</a> to create your Masumi identity and agent.</div>;
  }
  return <AgentDashboard />;
}

function AgentDashboard() {
  const health = useHealth();
  const status = usePoll(() => get<AgentStatus>("/agent/v1/me"), 2500);
  const loans = usePoll(() => get<Loan[]>("/api/me/loans"), 2500);
  const sync = usePoll(() => get<SyncState>("/api/me/sync"), 4000);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const lastId = useRef(0);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const next = await get<ActivityEntry[]>(`/agent/v1/activity?after=${lastId.current}`);
        if (!stop && next.length) {
          lastId.current = next.at(-1)!.id;
          setEntries(prev => [...prev, ...next].slice(-400));
          if (next.some(e => e.type === "tool_result")) { void status.refresh(); void loans.refresh(); void sync.refresh(); }
        }
      } catch { /* gateway restarting */ }
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loan = loans.data?.[0];
  const wallet = status.data?.wallet;
  const missing = loan?.status === "open" && wallet ? Math.max(0, Number(loan.outstanding) - Number(wallet.USDM)) : 0;
  const refreshAll = () => { void status.refresh(); void loans.refresh(); void sync.refresh(); };

  return (
    <div className="agent-grid">
      <div className="side-column">
        <Panel title="Agent wallet">
          {wallet ? (
            <>
              <div className="balance"><span className="balance-value">{Number(wallet.USDM).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span> <span className="unit">USDM</span></div>
              <div className="muted">{Number(wallet.tADA).toLocaleString(undefined, { maximumFractionDigits: 2 })} tADA for fees</div>
              <div className="kv"><span>Address</span><AddressLink address={wallet.address} /></div>
            </>
          ) : <ErrorNote error={status.error ?? "Loading…"} />}
        </Panel>
        <Panel title="Loan" actions={loan && <Badge tone={loanTone(loan.status)}>{loan.status}</Badge>}>
          {loan ? <LoanCard loan={loan} /> : <Empty>No loan yet. Your agent borrows only when a paywall costs more than it holds.</Empty>}
          {loan?.status === "open" && health?.mode === "simulated" && missing > 0 && wallet && (
            <div className="topup">
              <p>Your agent can't cover {loan.outstanding} USDM. Top it up before the deadline, or your redacted chats get published.</p>
              <button className="primary" onClick={async () => { await post("/api/sim/faucet", { address: wallet.address, usdm: missing.toFixed(6) }); refreshAll(); }}>Top up {missing.toFixed(2)} USDM</button>
              <p className="muted small">Then tell your AI: "repay my loan".</p>
            </div>
          )}
        </Panel>
        {health?.mode === "simulated" && wallet && (
          <Panel title="Demo controls">
            <button className="ghost" onClick={async () => { await post("/api/sim/set-usdm", { address: wallet.address, usdm: "0.05" }); refreshAll(); }}>Reset agent to 0.05 USDM</button>
          </Panel>
        )}
      </div>

      <Panel title="Live agent activity" className="activity-panel" actions={<span className="muted small">from Hermes, Claude Code, ChatGPT, Claude or curl</span>}>
        {entries.length ? <Activity entries={entries} /> : <Empty>Connect your AI app (Get started → Connect) and ask it something. Every tool call and x402 payment shows up here live.</Empty>}
      </Panel>

      <div className="side-column">
        <SyncPanel sync={sync.data} onSynced={sync.refresh} />
        <AskPanel />
      </div>
    </div>
  );
}

function SyncPanel({ sync, onSynced }: { sync?: SyncState; onSynced(): Promise<void> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  return (
    <Panel title="Synced context" actions={sync && <Badge tone={sync.readyToBorrow ? "good" : "warn"}>{sync.readyToBorrow ? "ready to borrow" : `${sync.items}/${sync.minimumForBorrowing}`}</Badge>}>
      {sync ? (
        <>
          <div className="kv"><span>Redacted items</span><strong>{sync.items}</strong></div>
          <div className="kv"><span>Sources</span><span>{Object.entries(sync.bySource).map(([s, n]) => `${s} ${n}`).join(" · ") || "none yet"}</span></div>
          {sync.latestCollateral && <div className="kv"><span>Locked as collateral</span><span>v{sync.latestCollateral.version} · {sync.latestCollateral.items} items · {sync.latestCollateral.status}</span></div>}
          <ul className="after-list compact sync-lines">{sync.recent.slice(0, 6).map((r, i) => <li key={i}><span className="muted small">{r.source}</span> {r.line}</li>)}</ul>
        </>
      ) : <Empty>Loading…</Empty>}
      <form className="sync-form" onSubmit={async e => {
        e.preventDefault(); setError(undefined);
        try { await post("/api/me/sync", { source: "assistant", items: text.split("\n") }); setText(""); await onSynced(); } catch (err) { setError((err as Error).message); }
      }}>
        <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={"Add context by hand, one line each\n(your AI apps sync it automatically)"} />
        <button className="ghost" disabled={!text.trim()}>Sync</button>
      </form>
      <ErrorNote error={error} />
    </Panel>
  );
}

function AskPanel() {
  const [message, setMessage] = useState("Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades");
  const [outcome, setOutcome] = useState<"" | "win" | "loss">("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string>();
  return (
    <Panel title="Or try it here" actions={<span className="muted small">built-in brain</span>}>
      <form onSubmit={async e => {
        e.preventDefault(); setBusy(true); setSummary(undefined);
        try { const r = await post<{ summary: string }>("/agent/v1/ask?format=json", { message, forceOutcome: outcome || undefined }); setSummary(r.summary); }
        catch (err) { setSummary((err as Error).message); } finally { setBusy(false); }
      }}>
        <textarea rows={3} value={message} onChange={e => setMessage(e.target.value)} />
        <div className="button-row">
          <select value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)} title="Simulated DEX outcome">
            <option value="">trade: by confidence</option><option value="win">trade: force win</option><option value="loss">trade: force loss</option>
          </select>
          <button className="primary" disabled={busy || !message.trim()}>{busy ? "Working…" : "Ask"}</button>
        </div>
      </form>
      {summary && <p className="bubble agent summary">{summary}</p>}
    </Panel>
  );
}

type Step =
  | { kind: "note"; tone: "thought" | "alert" | "meta" | "error"; text: string; at: string }
  | { kind: "tool"; tool: string; input: unknown; x402: Array<{ step: string; detail: any }>; result?: any; at: string };

function Activity({ entries }: { entries: ActivityEntry[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [entries.length]);
  const steps = useMemo(() => {
    const out: Step[] = [];
    for (const { type, data, at } of entries) {
      if (type === "run_started") out.push({ kind: "note", tone: "meta", text: `▶ "${data.message}" (brain: ${data.brain})`, at });
      else if (type === "assistant") out.push({ kind: "note", tone: "thought", text: data.text, at });
      else if (type === "notify_user") out.push({ kind: "note", tone: "alert", text: data.message, at });
      else if (type === "error") out.push({ kind: "note", tone: "error", text: data.message, at });
      else if (type === "tool_call") out.push({ kind: "tool", tool: data.tool, input: data.input, x402: [], at });
      else if (type === "x402" || type === "tool_result") {
        const open = [...out].reverse().find((s): s is Extract<Step, { kind: "tool" }> => s.kind === "tool" && s.tool === data.tool && s.result === undefined);
        if (!open) continue;
        if (type === "x402") open.x402.push({ step: data.step, detail: data.detail }); else open.result = data.result;
      }
    }
    return out;
  }, [entries]);
  return (
    <ol className="timeline">
      {steps.map((step, i) => step.kind === "note"
        ? <li key={i} className={`step ${step.tone === "thought" ? "thought" : step.tone === "alert" ? "alert-step" : step.tone === "error" ? "error-step" : "meta"}`}>{step.tone === "alert" && <strong>Your agent needs you · </strong>}{step.text}</li>
        : (
          <li key={i} className={`step tool ${step.result === undefined ? "pending" : step.result?.error ? "failed" : ""}`}>
            <div className="step-head">
              <span className="step-name">{TOOL_LABEL[step.tool] ?? step.tool}</span>
              <code className="step-fn">{step.tool}</code>
              <time className="muted small">{new Date(step.at).toLocaleTimeString()}</time>
              {step.result === undefined && <span className="spinner" />}
            </div>
            {step.x402.length > 0 && <X402Chips steps={step.x402} />}
            {step.result !== undefined && <div className="step-result">{summarize(step.tool, step.result)}</div>}
            {step.result !== undefined && <JsonToggle value={{ input: step.input, result: step.result }} />}
          </li>
        ))}
      <div ref={end} />
    </ol>
  );
}

function X402Chips({ steps }: { steps: Array<{ step: string; detail: any }> }) {
  return (
    <div className="x402-chips">
      {steps.map((s, i) => (
        <span key={i} className={`chip-x402 ${s.step}`}>
          {s.step === "request" ? `HTTP ${s.detail.status}` : s.step === "offer" ? `offer ${Number(s.detail.amount) / 1e6} USDM` : s.step === "signed" ? "signed by agent" : s.step === "pending" ? "settling…" : s.step}
          {s.step === "settled" && s.detail.transaction && <> · <TxLink hash={s.detail.transaction} /></>}
        </span>
      ))}
    </div>
  );
}

function summarize(tool: string, r: any): ReactNode {
  if (r?.error) return <span className="text-bad">{r.error}</span>;
  switch (tool) {
    case "carsem_status": return r.onboarded ? <>{r.wallet?.USDM} USDM · {r.syncedContext?.items} synced items{r.openLoan ? ` · loan open (${r.openLoan.outstanding_usdm} due)` : ""}</> : <span className="text-warn">{r.next}</span>;
    case "search_data": return <>{r.results.length} result(s){r.results[0] ? `, best: ${r.results[0].title} · ${r.results[0].price_usdm} USDM` : ""}</>;
    case "buy_data":
      if (r.status === "insufficient_funds") return <span className="text-warn">Paywall: costs {r.price_usdm} USDM, wallet holds {r.balance_usdm}</span>;
      if (r.status === "delivered") return (
        <>
          <strong>{r.listing.title}</strong> · paid {r.paid_usdm} USDM <TxLink hash={r.payment_tx} url={r.payment_explorer} />
          <div className="muted small">proof of delivery {short(r.delivery_hash, 10, 6)} → logged on chain</div>
        </>
      );
      return <span className="text-bad">{r.status}: {r.reason ?? r.error ?? r.message}</span>;
    case "sync_context": return <>{r.added} new redacted item(s) · {r.total_items} total{r.ready_to_borrow ? " · ready to borrow" : ""}</>;
    case "borrow":
      if (r.status === "sync_required") return <span className="text-warn">Needs synced context first</span>;
      return <>Loan <code>{r.loan_id}</code>: {r.amount_usdm} USDM + {r.fee_usdm} fee · {r.collateral} {r.disburse_tx && <TxLink hash={r.disburse_tx} url={r.disburse_explorer} />}</>;
    case "trade_signal": return (
      <>
        <span className={r.pnlUsdm >= 0 ? "text-good" : "text-bad"}>{r.outcome.toUpperCase()} {r.pnlUsdm >= 0 ? "+" : ""}{r.pnlUsdm} USDM</span> · {r.side} with {r.sizeAda} tADA
        {r.payout && <> · payout <TxLink hash={r.payout.tx.txHash} url={r.payout.tx.explorerUrl} /></>}
        <div className="muted small">{r.venue}</div>
      </>
    );
    case "my_loan": return r.open_loan ? <>open · {r.open_loan.outstanding_usdm} USDM due</> : <>no open loan</>;
    case "repay_loan":
      if (r.status === "insufficient_funds") return <span className="text-warn">Can't repay yet: {r.shortfall_usdm} USDM short</span>;
      if (r.status === "no_open_loan") return <>No open loan</>;
      return <><span className="text-good">Repaid {r.paid_usdm} USDM · collateral {r.collateral}</span> {r.payment_tx && <TxLink hash={r.payment_tx} />}</>;
    case "upload_data": return <>Listed <code>{r.id}</code> · {r.title} · {r.price} USDM</>;
    case "rate_data": return <>Rated {r.rating}</>;
    case "browse_published_data": return <>{r.published.length} published bundle(s)</>;
    case "access_published_data": return r.status === "accessed" ? <>Accessed {r.bundle.messages.length} redacted lines <TxLink hash={r.payment_tx} /></> : <span className="text-bad">{r.error ?? r.status}</span>;
    case "notify_user": return <>Notification sent</>;
    default: return null;
  }
}

function LoanCard({ loan }: { loan: Loan }) {
  const collateral =
    loan.status === "open" ? `Locked: ${loan.collateral.items ?? "?"} redacted items` :
    loan.status === "repaid" ? "Released back to you" :
    loan.status === "defaulted" ? "Published on CARSEM (keeps selling)" : "Pending";
  return (
    <div className="loan">
      <div className="loan-amounts">
        <div><div className="muted small">Borrowed</div><div className="big">{loan.amount}</div></div>
        <div><div className="muted small">Fee</div><div className="big">{loan.fee}</div></div>
        <div><div className="muted small">Outstanding</div><div className={`big ${loan.status === "open" ? "text-warn" : ""}`}>{loan.outstanding}</div></div>
      </div>
      {loan.status === "open" && loan.deadline && (
        <div className="deadline">
          <div className="kv"><span>Deadline</span><Countdown deadline={loan.deadline} /></div>
          <DeadlineBar createdAt={loan.events.find(e => e.kind === "disbursed")?.at ?? loan.createdAt} deadline={loan.deadline} />
        </div>
      )}
      <div className="kv"><span>Collateral</span><span>{collateral}</span></div>
      <div className="kv"><span>collateral_ref</span><code title={loan.collateral.ref}>{short(loan.collateral.ref, 10, 6)}</code></div>
      <ul className="loan-events">
        {loan.events.map((e, i) => <li key={i}><span className="event-kind">{e.kind.replace(/_/g, " ")}</span>{e.amount && <span>{e.amount} USDM</span>}{e.tx && <TxLink hash={e.tx.hash} url={e.tx.explorerUrl} />}</li>)}
      </ul>
    </div>
  );
}

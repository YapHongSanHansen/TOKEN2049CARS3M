import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEMO_AGENT, get, post, type AgentEvent, type AgentWallet, type Loan } from "../api";
import { AddressLink, Badge, Countdown, DeadlineBar, Empty, ErrorNote, JsonToggle, Panel, TxLink, loanTone, short } from "../components";
import { useHealth, usePoll } from "../hooks";

interface RunState { id: string; message: string; events: AgentEvent[]; status: "running" | "finished" | "failed" }

const PROMPTS = ["Get me a trading signal for MIN and trade it", "Trade SNEK for me", "Repay my loan"];
const TOOL_LABEL: Record<string, string> = {
  check_balance: "Check balance", get_signal: "Buy signal (x402)", borrow: "Borrow from CARSEM", execute_trade: "Trade on DEX",
  loan_status: "Loan status", my_loans: "My loans", repay: "Repay loan (x402)", notify_user: "Notify user",
};

export function AgentView() {
  const health = useHealth();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [input, setInput] = useState(PROMPTS[0]);
  const [brain, setBrain] = useState<"auto" | "claude" | "scripted">("auto");
  const [outcome, setOutcome] = useState<"auto" | "win" | "loss">("auto");
  const [error, setError] = useState<string>();
  const wallet = usePoll(() => get<AgentWallet>("/agent/wallet"), 3000);
  const loans = usePoll(() => get<Loan[]>(`/api/loans?agentId=${DEMO_AGENT}`), 3000);
  const running = runs.some(r => r.status === "running");
  const refreshSide = () => { void wallet.refresh(); void loans.refresh(); };

  const update = (id: string, change: (run: RunState) => RunState) => setRuns(prev => prev.map(r => (r.id === id ? change(r) : r)));

  async function send(message: string) {
    if (!message.trim() || running) return;
    setError(undefined);
    try {
      const { id } = await post<{ id: string }>("/agent/runs", {
        message, brain: brain === "auto" ? undefined : brain, forceOutcome: outcome === "auto" ? undefined : outcome,
      });
      setRuns(prev => [...prev, { id, message, events: [], status: "running" }]);
      const source = new EventSource(`/agent/runs/${id}/events`);
      source.onmessage = e => {
        const event = JSON.parse(e.data) as AgentEvent;
        update(id, r => ({ ...r, events: [...r.events, event] }));
        if (event.type === "tool_result") refreshSide();
      };
      // The server closes the stream when the run ends; reconcile with the final record.
      source.onerror = async () => {
        source.close();
        for (;;) {
          const run = await get<{ status: RunState["status"]; events: AgentEvent[] }>(`/agent/runs/${id}`).catch(() => undefined);
          if (run && run.status !== "running") { update(id, r => ({ ...r, events: run.events, status: run.status })); break; }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        refreshSide();
      };
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const current = runs.at(-1);
  const loan = loans.data?.[0];
  const missing = loan?.status === "open" && wallet.data ? Math.max(0, Number(loan.outstanding) - Number(wallet.data.tUSDM)) : 0;

  return (
    <div className="agent-grid">
      <Panel title="Chat" className="chat-panel">
        <Chat runs={runs} />
        <ErrorNote error={error} />
        <div className="prompt-chips">
          {PROMPTS.map(p => <button key={p} className="chip" disabled={running} onClick={() => { setInput(p); void send(p); }}>{p}</button>)}
        </div>
        <form className="composer" onSubmit={e => { e.preventDefault(); void send(input); }}>
          <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask your agent…" disabled={running} />
          <button className="primary" disabled={running || !input.trim()}>{running ? "Working…" : "Send"}</button>
        </form>
      </Panel>

      <Panel title="Agent activity" actions={current && <Badge tone={current.status === "running" ? "info" : current.status === "failed" ? "bad" : "good"}>{current.status}</Badge>} className="activity-panel">
        {current ? <Activity run={current} /> : <Empty>Every tool call and x402 message the agent makes shows up here.</Empty>}
      </Panel>

      <div className="side-column">
        <Panel title="Agent wallet">
          {wallet.data ? (
            <>
              <div className="balance"><span className="balance-value">{Number(wallet.data.tUSDM).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span> <span className="unit">tUSDM</span></div>
              <div className="muted">{Number(wallet.data.tADA).toLocaleString(undefined, { maximumFractionDigits: 2 })} tADA for fees</div>
              <div className="kv"><span>Address</span><AddressLink address={wallet.data.address} /></div>
            </>
          ) : <ErrorNote error={wallet.error ?? "Loading…"} />}
        </Panel>

        <Panel title="Loan" actions={loan && <Badge tone={loanTone(loan.status)}>{loan.status}</Badge>}>
          {loan ? <LoanCard loan={loan} /> : <Empty>No loan yet. The agent borrows only when a paywall costs more than it holds.</Empty>}
          {loan?.status === "open" && health?.mode === "simulated" && missing > 0 && (
            <div className="topup">
              <p>The agent can't cover {loan.outstanding} tUSDM. Top it up before the deadline, or the bundle gets listed.</p>
              <button className="primary" onClick={async () => {
                await post("/api/sim/faucet", { address: wallet.data!.address, usdm: missing.toFixed(6) });
                refreshSide();
                setInput("Repay my loan");
              }}>Top up {missing.toFixed(2)} tUSDM</button>
            </div>
          )}
        </Panel>

        <Panel title="Demo controls">
          <label className="field">Brain
            <select value={brain} onChange={e => setBrain(e.target.value as typeof brain)}>
              <option value="auto">auto (Claude if a key is set)</option><option value="claude">Claude</option><option value="scripted">scripted</option>
            </select>
          </label>
          <label className="field">Trade outcome
            <select value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}>
              <option value="auto">by signal confidence</option><option value="win">force win (green path)</option><option value="loss">force loss (red path)</option>
            </select>
          </label>
          {health?.mode === "simulated" && wallet.data && (
            <button className="ghost" onClick={async () => { await post("/api/sim/set-usdm", { address: wallet.data!.address, usdm: "0.05" }); refreshSide(); }}>
              Reset agent to 0.05 tUSDM
            </button>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Chat({ runs }: { runs: RunState[] }) {
  const end = useRef<HTMLDivElement>(null);
  const count = runs.reduce((n, r) => n + r.events.length, runs.length);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [count]);
  if (!runs.length) {
    return (
      <div className="chat-empty">
        <p className="lede">Ask the agent for a trading signal.</p>
        <p className="muted">It holds only 0.05 tUSDM, and the signal costs 5. Watch it hit the paywall, borrow against your redacted data, pay over x402, trade, and repay.</p>
      </div>
    );
  }
  return (
    <div className="chat">
      {runs.map(run => {
        const texts = run.events.filter(e => e.type === "assistant").map(e => (e as { text: string }).text);
        return (
          <div key={run.id} className="chat-run">
            <div className="bubble user">{run.message}</div>
            {run.events.map((event, i) => {
              if (event.type === "assistant") return <div key={i} className="bubble agent">{event.text}</div>;
              if (event.type === "notify_user") return <div key={i} className="bubble alert"><strong>Your agent needs you</strong>{event.message}</div>;
              if (event.type === "error") return <div key={i} className="bubble error">{event.message}</div>;
              if (event.type === "run_finished" && event.summary && event.summary !== texts.at(-1)) return <div key={i} className="bubble agent summary">{event.summary}</div>;
              return null;
            })}
            {run.status === "running" && <div className="bubble agent typing"><span /><span /><span /></div>}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

type Step =
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: string; input: unknown; x402: Array<Extract<AgentEvent, { type: "x402" }>>; result?: any };

function Activity({ run }: { run: RunState }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [run.events.length]);
  const steps = useMemo(() => {
    const out: Step[] = [];
    for (const event of run.events) {
      if (event.type === "assistant") out.push({ kind: "thought", text: event.text });
      else if (event.type === "tool_call") out.push({ kind: "tool", tool: event.tool, input: event.input, x402: [] });
      else if (event.type === "x402" || event.type === "tool_result") {
        const open = [...out].reverse().find((s): s is Extract<Step, { kind: "tool" }> => s.kind === "tool" && s.tool === event.tool && s.result === undefined);
        if (!open) continue;
        if (event.type === "x402") open.x402.push(event);
        else open.result = event.result;
      }
    }
    return out;
  }, [run.events]);
  const brain = run.events.find(e => e.type === "run_started");
  return (
    <ol className="timeline">
      {brain?.type === "run_started" && <li className="step meta">brain: {brain.brain}</li>}
      {steps.map((step, i) => step.kind === "thought"
        ? <li key={i} className="step thought">{step.text}</li>
        : (
          <li key={i} className={`step tool ${step.result === undefined ? "pending" : step.result?.error ? "failed" : ""}`}>
            <div className="step-head">
              <span className="step-name">{TOOL_LABEL[step.tool] ?? step.tool}</span>
              <code className="step-fn">{step.tool}</code>
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

function X402Chips({ steps }: { steps: Array<Extract<AgentEvent, { type: "x402" }>> }) {
  return (
    <div className="x402-chips">
      {steps.map((s, i) => {
        const label =
          s.step === "request" ? `HTTP ${s.detail.status}` :
          s.step === "offer" ? `offer ${Number(s.detail.amount) / 1e6} tUSDM` :
          s.step === "signed" ? "signed by agent" :
          s.step === "pending" ? `settling… (${s.detail.attempt})` :
          s.step === "settled" ? "settled" : s.step;
        return (
          <span key={i} className={`chip-x402 ${s.step}`}>
            {label}{s.step === "settled" && s.detail.transaction && <> · <TxLink hash={s.detail.transaction} /></>}
          </span>
        );
      })}
    </div>
  );
}

function summarize(tool: string, r: any): ReactNode {
  if (r?.error) return <span className="text-bad">{r.error}</span>;
  switch (tool) {
    case "check_balance": return <>{r.tUSDM} tUSDM · {r.tADA} tADA</>;
    case "get_signal":
      if (r.status === "insufficient_funds") return <span className="text-warn">Paywall: costs {r.price_usdm} tUSDM, wallet holds {r.balance_usdm}</span>;
      if (r.status === "delivered") return (
        <>
          <strong>{r.signal.direction.toUpperCase()} {r.signal.pair}</strong> · {Math.round(r.signal.confidence * 100)}% · by {r.signal.uploader.name} · paid {r.paid_usdm} tUSDM <TxLink hash={r.payment_tx} url={r.payment_explorer} />
          <div className="muted small">delivery hash {short(r.delivery_hash, 10, 6)} → logged on chain</div>
        </>
      );
      return <span className="text-bad">{r.status}: {r.reason ?? r.error}</span>;
    case "borrow": return <>Loan <code>{r.loan_id}</code>: {r.amount_usdm} tUSDM + {r.fee_usdm} fee {r.disburse_tx && <TxLink hash={r.disburse_tx} url={r.disburse_explorer} />}</>;
    case "execute_trade": return (
      <>
        <span className={r.pnlUsdm >= 0 ? "text-good" : "text-bad"}>{r.outcome.toUpperCase()} {r.pnlUsdm >= 0 ? "+" : ""}{r.pnlUsdm} tUSDM</span> · {r.side} with {r.sizeAda} tADA
        {r.payout && <> · payout <TxLink hash={r.payout.tx.txHash} url={r.payout.tx.explorerUrl} /></>}
        <div className="muted small">{r.venue}</div>
      </>
    );
    case "loan_status": return <>{r.status} · {r.outstanding_usdm} tUSDM outstanding</>;
    case "my_loans": return <>{r.length} loan(s){r[0] ? ` · latest ${r[0].status}, ${r[0].outstanding_usdm} outstanding` : ""}</>;
    case "repay":
      if (r.status === "insufficient_funds") return <span className="text-warn">Can't repay: due {r.due_usdm}, wallet holds {r.balance_usdm}</span>;
      return <><span className="text-good">Repaid {r.paid_usdm} tUSDM · collateral {r.collateral}</span> {r.payment_tx && <TxLink hash={r.payment_tx} />}</>;
    case "notify_user": return <>Notification sent to the user</>;
    default: return null;
  }
}

function LoanCard({ loan }: { loan: Loan }) {
  const recovered = loan.status === "defaulted" && Number(loan.outstanding) === 0;
  const collateral =
    loan.status === "open" ? "Pledged: your redacted chat bundle" :
    loan.status === "repaid" ? "Released back to you" :
    recovered ? "Debt covered by a data sale; bundle released, surplus paid to you" :
    loan.status === "defaulted" ? "Listed on the CARSEM market" : "Pending";
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
          <DeadlineBar createdAt={loan.events[0]?.at ?? loan.createdAt} deadline={loan.deadline} />
        </div>
      )}
      <div className="kv"><span>Collateral</span><span>{collateral}</span></div>
      <div className="kv"><span>collateral_ref</span><code title={loan.collateralRef}>{short(loan.collateralRef, 10, 6)}</code></div>
      <ul className="loan-events">
        {loan.events.map((e, i) => (
          <li key={i}><span className="event-kind">{e.kind.replace(/_/g, " ")}</span>{e.amount && <span>{e.amount} tUSDM</span>}{e.tx && <TxLink hash={e.tx.hash} url={e.tx.explorerUrl} />}</li>
        ))}
      </ul>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, post, type ActivityEntry, type AgentStatus, type Loan, type LoanRequest, type MessagesState, type PastMessage } from "../api";
import { Countdown, DeadlineBar, ErrorNote, JsonToggle, TxLink, short } from "../components";
import { useHealth, usePoll, useSession } from "../hooks";

const SUGGESTIONS = [
  "Find me trading signals on CARSEM, I want some pocket money from Cardano DEX trades",
  "Cheapest flight from Kuala Lumpur to Singapore",
  "Cheapest hotel at Singapore Geylang",
  "Cheapest Pokemon Pack 30th Anniversary",
];
const SINCE_KEY = "carsem.chatSince";
const readSince = () => { try { return Number(localStorage.getItem(SINCE_KEY) ?? 0); } catch { return 0; } };

export function AgentView() {
  const { key, profile } = useSession();
  if (!key || !profile?.onboarded) {
    return <div className="offline-note">Verify first: open <a href="#start">Get started</a> to create your Masumi identity and agent.</div>;
  }
  return <Chat />;
}

// ---- the page ---------------------------------------------------------------------------

function Chat() {
  const { profile } = useSession();
  const health = useHealth();
  const status = usePoll(() => get<AgentStatus>("/agent/v1/me"), 3000);
  const loans = usePoll(() => get<Loan[]>("/api/me/loans"), 3000);
  const history = usePoll(() => get<MessagesState>("/api/me/messages"), 4000);
  const requests = usePoll(() => get<LoanRequest[]>("/api/me/loan-requests"), 1500);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [since, setSince] = useState(readSince);
  const [pending, setPending] = useState<string>();
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<"" | "win" | "loss">("");
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1180);
  const [error, setError] = useState<string>();
  const lastId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const refreshSide = () => { void status.refresh(); void loans.refresh(); void history.refresh(); void requests.refresh(); };

  // Live transcript from the agent's activity (this page, Hermes, Claude Code, ChatGPT, curl).
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const next = await get<ActivityEntry[]>(`/agent/v1/activity?after=${lastId.current}`);
        if (!stop && next.length) {
          lastId.current = next.at(-1)!.id;
          setEntries(prev => [...prev, ...next].slice(-600));
          if (next.some(e => e.type === "tool_result" || e.type === "run_finished")) refreshSide();
        }
      } catch { /* gateway restarting */ }
    };
    void tick();
    const timer = setInterval(tick, 1200);
    return () => { stop = true; clearInterval(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => entries.filter(e => e.id > since), [entries, since]);
  const turns = useMemo(() => buildTurns(visible), [visible]);
  const request = requests.data?.[0];

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [turns.length, visible.length, pending, request?.id]);

  async function send(message: string) {
    const text = message.trim();
    if (!text || working) return;
    setPending(text); setWorking(true); setError(undefined);
    try { await post("/agent/v1/ask?format=json", { message: text, forceOutcome: outcome || undefined }); }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(false); setPending(undefined); refreshSide(); }
  }

  function newChat() {
    const marker = lastId.current;
    try { localStorage.setItem(SINCE_KEY, String(marker)); } catch { /* ignore */ }
    setSince(marker);
  }

  const wallet = status.data?.wallet;
  const loan = loans.data?.[0];
  const hasThread = turns.length > 0 || !!pending;
  const showPending = pending && !turns.some(t => t.kind === "ask" && t.message === pending && t.live);

  return (
    <div className={`chat-app ${panelOpen ? "panel-open" : ""}`}>
      <Sidebar history={history.data} onChanged={history.refresh} onNewChat={newChat} name={profile?.name ?? ""} />

      <section className="c-main">
        <header className="c-main-head">
          <span className="c-title">Your CARSEM agent · {health?.mode === "preprod" ? "Cardano preprod" : "simulated chain"}</span>
          <button className="c-pill" onClick={() => setPanelOpen(!panelOpen)} title="Wallet and loan">
            <span className={`dot ${loan?.status === "open" ? "warn" : loan?.status === "defaulted" ? "bad" : ""}`} />
            {wallet ? `${Number(wallet.USDM).toLocaleString(undefined, { maximumFractionDigits: 4 })} USDM` : "wallet"}
            {loan?.status === "open" && <> · loan due</>}
          </button>
        </header>

        <div className="c-scroll" ref={scroller}>
          {!hasThread ? (
            <div className="c-welcome">
              <h1><span className="mark">✻</span>{greeting()}, {profile?.name}</h1>
              <p>Ask for trading signals or the cheapest flights, hotels and products. When something costs more than your agent holds, it will ask you which past messages to pledge for a loan.</p>
              <Composer onSend={send} working={working} outcome={outcome} setOutcome={setOutcome} autoFocus />
              <div className="c-suggestions">{SUGGESTIONS.map(s => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}</div>
              <p className="c-foot-note">Also works from Hermes, Claude Code, ChatGPT and Claude: their activity shows up here too.</p>
            </div>
          ) : (
            <div className="c-thread">
              {turns.map((turn, i) => <Turn key={i} turn={turn} />)}
              {showPending && (
                <>
                  <div className="c-user">{pending}</div>
                  <div className="c-assistant"><span className="c-mark">✻</span><div className="c-body"><div className="c-typing"><span /><span /><span /></div></div></div>
                </>
              )}
              {working && !showPending && !request && <div className="c-assistant"><span className="c-mark">✻</span><div className="c-body"><div className="c-typing"><span /><span /><span /></div></div></div>}
              {request && <ApproveCard request={request} history={history.data} onDone={refreshSide} />}
              <ErrorNote error={error} />
            </div>
          )}
        </div>

        {hasThread && (
          <div className="c-composer-wrap">
            <Composer onSend={send} working={working} outcome={outcome} setOutcome={setOutcome} />
          </div>
        )}
      </section>

      {panelOpen && <SidePanel status={status.data} loan={loan} onChanged={refreshSide} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

// ---- composer ------------------------------------------------------------------------------

function Composer({ onSend, working, outcome, setOutcome, autoFocus }: { onSend(text: string): void; working: boolean; outcome: string; setOutcome(v: "" | "win" | "loss"): void; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!area.current) return;
    area.current.style.height = "auto";
    area.current.style.height = `${Math.min(area.current.scrollHeight, 200)}px`;
  }, [text]);
  const submit = () => { if (!text.trim() || working) return; onSend(text); setText(""); };
  return (
    <div className="c-composer">
      <textarea ref={area} rows={1} value={text} autoFocus={autoFocus} placeholder={working ? "Your agent is working…" : "Ask your agent…"}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
      <div className="c-composer-row">
        <select value={outcome} onChange={e => setOutcome(e.target.value as "" | "win" | "loss")} title="Demo: simulated DEX trade outcome">
          <option value="">Trade: by signal confidence</option><option value="win">Trade: force win</option><option value="loss">Trade: force loss</option>
        </select>
        <button className="c-send" disabled={working || !text.trim()} onClick={submit} aria-label="Send">↑</button>
      </div>
    </div>
  );
}

// ---- transcript ------------------------------------------------------------------------------

type ToolStep = { tool: string; input: any; x402: Array<{ step: string; detail: any }>; result?: any };
type Part = { kind: "text"; text: string } | { kind: "tool"; step: ToolStep } | { kind: "notice"; text: string; tone: "warn" | "bad" };
type TurnT = { kind: "ask"; message: string; parts: Part[]; live: boolean; at: string } | { kind: "app"; parts: Part[]; at: string };

function buildTurns(entries: ActivityEntry[]): TurnT[] {
  const turns: TurnT[] = [];
  let current: TurnT | undefined;
  let lastAt = 0;
  for (const { type, data, at } of entries) {
    const t = Date.parse(at);
    if (type === "run_started") {
      current = { kind: "ask", message: data.message, parts: [], live: true, at };
      turns.push(current);
    } else {
      // Activity outside a chat run comes from a connected app (Hermes, Claude Code, ChatGPT…).
      if (!current || (current.kind === "app" && t - lastAt > 90_000) || (current.kind === "ask" && !current.live)) {
        if (type === "run_finished") continue;
        current = { kind: "app", parts: [], at };
        turns.push(current);
      }
      const parts = current.parts;
      if (type === "assistant") parts.push({ kind: "text", text: data.text });
      else if (type === "notify_user") parts.push({ kind: "notice", text: data.message, tone: "warn" });
      else if (type === "error") parts.push({ kind: "notice", text: data.message, tone: "bad" });
      else if (type === "tool_call" && data.tool !== "notify_user") parts.push({ kind: "tool", step: { tool: data.tool, input: data.input, x402: [] } });
      else if (type === "x402" || type === "tool_result") {
        const open = [...parts].reverse().find((p): p is Extract<Part, { kind: "tool" }> => p.kind === "tool" && p.step.tool === data.tool && p.step.result === undefined);
        if (open) { if (type === "x402") open.step.x402.push({ step: data.step, detail: data.detail }); else open.step.result = data.result; }
      } else if (type === "run_finished" && current.kind === "ask") {
        const lastText = [...parts].reverse().find(p => p.kind === "text") as { text: string } | undefined;
        if (data.summary && data.summary !== lastText?.text) parts.push({ kind: "text", text: data.summary });
        current.live = false;
      }
    }
    lastAt = t;
  }
  return turns;
}

function Turn({ turn }: { turn: TurnT }) {
  return (
    <>
      {turn.kind === "ask" && <div className="c-user">{turn.message}</div>}
      <div className="c-assistant">
        <span className="c-mark">✻</span>
        <div className="c-body">
          {turn.kind === "app" && <div className="c-source">From your connected app · {new Date(turn.at).toLocaleTimeString()}</div>}
          {turn.parts.map((part, i) =>
            part.kind === "text" ? <div key={i} className="c-text">{part.text}</div>
            : part.kind === "notice" ? <div key={i} className={`c-callout ${part.tone === "bad" ? "bad" : ""}`}><strong>{part.tone === "bad" ? "Something went wrong" : "Your agent needs you"}</strong>{part.text}</div>
            : <ToolRow key={i} step={part.step} />)}
          {turn.kind === "ask" && turn.live && !waitingOnTool(turn.parts) && <div className="c-typing"><span /><span /><span /></div>}
        </div>
      </div>
    </>
  );
}

const waitingOnTool = (parts: Part[]) => { const last = parts.at(-1); return last?.kind === "tool" && last.step.result === undefined; };

function ToolRow({ step }: { step: ToolStep }) {
  const { icon, label } = describeTool(step);
  const failed = !!step.result?.error;
  return (
    <details className={`c-tool ${failed ? "failed" : ""}`}>
      <summary>
        <span className="icon">{icon}</span>
        <span className="what">{label}</span>
        {step.result === undefined ? <span className="spinner" /> : <span className="chev">›</span>}
      </summary>
      <div className="c-tool-detail">
        {step.x402.length > 0 && <X402Chips steps={step.x402} />}
        {step.result !== undefined && <div className="line">{toolDetail(step.tool, step.result)}</div>}
        <JsonToggle value={{ input: step.input, result: step.result }} label="raw" />
      </div>
    </details>
  );
}

function X402Chips({ steps }: { steps: Array<{ step: string; detail: any }> }) {
  return (
    <div className="x402-chips">
      {steps.map((s, i) => (
        <span key={i} className={`chip-x402 ${s.step}`}>
          {s.step === "request" ? `HTTP ${s.detail.status}` : s.step === "offer" ? `offer ${Number(s.detail.amount) / 1e6} USDM` : s.step === "signed" ? "signed by your agent" : s.step === "pending" ? "settling…" : s.step}
          {s.step === "settled" && s.detail.transaction && <> · <TxLink hash={s.detail.transaction} /></>}
        </span>
      ))}
    </div>
  );
}

function describeTool({ tool, input, result: r }: ToolStep): { icon: string; label: ReactNode } {
  const done = r !== undefined;
  if (r?.error) return { icon: "!", label: <><strong>{tool.replace(/_/g, " ")}</strong> failed: {r.error}</> };
  switch (tool) {
    case "carsem_status": return { icon: "◎", label: <>Checked your CARSEM account</> };
    case "search_data": return { icon: "⌕", label: <>Searched CARSEM for <strong>{input.category}{input.query ? ` · ${input.query}` : ""}</strong>{done ? ` — ${r.results.length} result(s)` : ""}</> };
    case "buy_data":
      if (!done) return { icon: "◇", label: <>Buying data over x402…</> };
      if (r.status === "insufficient_funds") return { icon: "◇", label: <>Hit a paywall: <strong>{r.price_usdm} USDM</strong>, wallet holds {r.balance_usdm}</> };
      if (r.status === "delivered") return { icon: "◆", label: <>Bought <strong>{r.listing.title}</strong> for {r.paid_usdm} USDM</> };
      return { icon: "◇", label: <>Purchase: {r.status}</> };
    case "list_my_messages": return { icon: "≡", label: <>Read your past messages</> };
    case "add_messages": return { icon: "+", label: <>Added {done ? r.added : "…"} message(s) to your history</> };
    case "borrow":
      if (!done) return { icon: "⟐", label: <>Collateral borrowing…</> };
      if (r.status === "selection_required") return { icon: "⟐", label: <>Asked you to choose messages to pledge for <strong>{r.amount_usdm} USDM</strong></> };
      return { icon: "⟐", label: <>Borrowed <strong>{r.amount_usdm} USDM</strong> · {r.collateral?.split(" (")[0]}</> };
    case "borrow_status":
      if (!done) return { icon: "⟐", label: <>Waiting for you to choose…</> };
      return { icon: "⟐", label: r.status === "borrowed" ? <>You approved: borrowed <strong>{r.amount_usdm} USDM</strong></> : <>Borrow request {r.status}</> };
    case "trade_signal": return { icon: "↗", label: done ? <>Traded on the DEX: <strong className={r.pnlUsdm >= 0 ? "text-good" : "text-bad"}>{r.outcome} {r.pnlUsdm >= 0 ? "+" : ""}{r.pnlUsdm} USDM</strong></> : <>Trading on the DEX…</> };
    case "my_loan": return { icon: "◷", label: <>Checked your loan</> };
    case "repay_loan":
      if (!done) return { icon: "✓", label: <>Repaying over x402…</> };
      if (r.status === "repaid") return { icon: "✓", label: <>Repaid <strong>{r.paid_usdm} USDM</strong> · your messages are unlocked</> };
      if (r.status === "insufficient_funds") return { icon: "✓", label: <>Can't repay yet: {r.shortfall_usdm} USDM short</> };
      return { icon: "✓", label: <>Repay: {r.status}</> };
    case "upload_data": return { icon: "↑", label: <>Uploaded {input.category} data</> };
    case "rate_data": return { icon: "★", label: <>Rated data {input.useful ? "useful" : "not useful"}</> };
    case "browse_published_data": return { icon: "≡", label: <>Browsed published chats</> };
    case "access_published_data": return { icon: "◆", label: <>Accessed published chats</> };
    default: return { icon: "·", label: <>{tool}</> };
  }
}

function toolDetail(tool: string, r: any): ReactNode {
  if (r?.error) return <span className="text-bad">{r.error}</span>;
  switch (tool) {
    case "buy_data":
      if (r.status === "delivered") return <>Paid over x402 <TxLink hash={r.payment_tx} url={r.payment_explorer} /> · proof of delivery <code>{short(r.delivery_hash, 10, 6)}</code> logged on chain</>;
      return r.message ?? null;
    case "search_data": return <ul className="after-list compact">{r.results.slice(0, 4).map((x: any) => <li key={x.listing_id}>{x.title} · {x.price_usdm} USDM · {x.uploader} ({x.uploader_reputation})</li>)}</ul>;
    case "borrow": case "borrow_status":
      if (r.status === "borrowed") return <>Fee {r.fee_usdm} USDM, due {r.total_due_usdm} USDM {r.deadline && <>by {new Date(r.deadline).toLocaleTimeString()}</>} · {r.collateral} {r.disburse_tx && <TxLink hash={r.disburse_tx} url={r.disburse_explorer} />}</>;
      return r.next ?? null;
    case "trade_signal": return <>{r.side} with {r.sizeAda} tADA · {r.venue} {r.payout && <TxLink hash={r.payout.tx.txHash} url={r.payout.tx.explorerUrl} />}</>;
    case "repay_loan": return r.payment_tx ? <TxLink hash={r.payment_tx} /> : null;
    default: return null;
  }
}

// ---- approval: the user chooses which past messages to pledge -----------------------------------

function ApproveCard({ request, history, onDone }: { request: LoanRequest; history?: MessagesState; onDone(): void }) {
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const available = (history?.messages ?? []).filter(m => !m.state);
  const min = request.minMessagesToPledge;
  const fee = (Number(request.amount) * 0.02).toFixed(2);
  const toggle = (id: number) => setChosen(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await action(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="c-assistant">
      <span className="c-mark">✻</span>
      <div className="c-body">
        <div className="c-approve">
          <h4>Collateral borrowing: {request.amount} USDM</h4>
          <p className="lead">Your agent wants to borrow {request.amount} USDM (+{fee} fee) for <strong>{request.purpose}</strong>. Choose which of your past messages to pledge. Only these are locked, and if the loan isn't repaid in time they are published on CARSEM for others to buy.</p>
          {available.length < min ? (
            <p className="warn-note">You have {available.length} past message(s); at least {min} are needed. Add your history from the sidebar (import a ChatGPT or Claude export, or add the sample chats), then choose here.</p>
          ) : (
            <ul className="c-pick">
              {available.map(m => (
                <li key={m.id} className={chosen.includes(m.id) ? "on" : ""}>
                  <label>
                    <input type="checkbox" checked={chosen.includes(m.id)} onChange={() => toggle(m.id)} />
                    <span>{m.text}<span className="tags">{m.source}{m.intents.length ? ` · ${m.intents.join(" · ")}` : ""}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="c-approve-foot">
            <span className="muted small">{chosen.length} chosen · at least {min}</span>
            <div className="button-row" style={{ marginTop: 0 }}>
              <button className="ghost" disabled={busy} onClick={() => void act(() => post(`/api/loan-requests/${request.id}/decline`))}>Decline</button>
              <button className="primary" disabled={busy || chosen.length < min} onClick={() => void act(() => post("/api/loans", { requestId: request.id, messageIds: chosen }))}>
                {busy ? "Borrowing…" : `Pledge ${chosen.length} message${chosen.length === 1 ? "" : "s"} & borrow`}
              </button>
            </div>
          </div>
          <ErrorNote error={error} />
        </div>
      </div>
    </div>
  );
}

// ---- sidebar: your past messages ----------------------------------------------------------------

function Sidebar({ history, onChanged, onNewChat, name }: { history?: MessagesState; onChanged(): Promise<void>; onNewChat(): void; name: string }) {
  const [note, setNote] = useState<string>();
  const run = async (action: () => Promise<{ added?: number }>) => {
    setNote(undefined);
    try { const r = await action(); setNote(`Added ${r.added ?? 0} message(s)`); await onChanged(); }
    catch (e) { setNote((e as Error).message); }
  };
  const importFile = async (file: File) => {
    const content = await file.text();
    const format = content.includes("\"mapping\"") ? "chatgpt" : content.includes("\"chat_messages\"") ? "claude" : undefined;
    if (!format) throw new Error("That doesn't look like a ChatGPT or Claude conversations.json export");
    return post<{ added: number }>("/api/me/messages/import", { format, content });
  };
  return (
    <aside className="c-sidebar">
      <button className="c-new" onClick={onNewChat}><span>+</span>New chat</button>
      <div className="c-section"><span>Your past messages</span><span>{history?.messages.length ?? 0}</span></div>
      <ul className="c-history">
        {(history?.messages ?? []).map((m: PastMessage) => (
          <li key={m.id} title={m.text}>
            <span className="line">{m.text}</span>
            <span className="meta"><span>{m.source.replace("_", " ")}</span>{m.state && <span className="locked">· {m.state}</span>}</span>
          </li>
        ))}
        {!history?.messages.length && <li className="muted small">No messages yet. They come from your AI apps, or add them below.</li>}
      </ul>
      <div className="c-sidebar-actions">
        <label>Import ChatGPT / Claude export…<input type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void run(() => importFile(f)); e.target.value = ""; }} /></label>
        <button onClick={() => void run(() => post("/api/me/messages/sample"))}>Add sample chats (demo)</button>
        {note && <span className="muted small" style={{ padding: "0 10px" }}>{note}</span>}
      </div>
      <div className="c-account">
        <span className="c-avatar">{name.slice(0, 1).toUpperCase()}</span>
        <span><span className="who">{name}</span><br /><span className="did">✓ Masumi DID verified</span></span>
      </div>
    </aside>
  );
}

// ---- side panel: wallet and loan -------------------------------------------------------------------

function SidePanel({ status, loan, onChanged, onClose }: { status?: AgentStatus; loan?: Loan; onChanged(): void; onClose(): void }) {
  const health = useHealth();
  const wallet = status?.wallet;
  const missing = loan?.status === "open" && wallet ? Math.max(0, Number(loan.outstanding) - Number(wallet.USDM)) : 0;
  return (
    <aside className="c-panel">
      <div className="kv"><h5>Wallet</h5><button className="link-button" onClick={onClose}>hide</button></div>
      <div className="c-card">
        {wallet ? (
          <>
            <div className="balance"><span className="balance-value">{Number(wallet.USDM).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span><span className="unit">USDM</span></div>
            <div className="muted small">{Number(wallet.tADA).toLocaleString(undefined, { maximumFractionDigits: 2 })} tADA for fees · one platform wallet</div>
            <div className="kv"><span>Address</span><code title={wallet.address}>{short(wallet.address, 12, 6)}</code></div>
          </>
        ) : <span className="muted">Loading…</span>}
      </div>

      <h5>Loan</h5>
      <div className="c-card">
        {loan ? <LoanCard loan={loan} /> : <span className="muted small">No loan yet. Your agent asks before it borrows, and you choose which past messages to pledge.</span>}
        {loan?.status === "open" && health?.mode === "simulated" && missing > 0 && wallet && (
          <div className="topup">
            <p>Your agent can't cover {loan.outstanding} USDM yet. Top it up before the deadline, or your pledged messages get published.</p>
            <button className="primary" onClick={async () => { await post("/api/sim/faucet", { address: wallet.address, usdm: missing.toFixed(6) }); onChanged(); }}>Top up {missing.toFixed(2)} USDM</button>
            <p className="muted small" style={{ margin: "8px 0 0" }}>Then ask: "repay my loan".</p>
          </div>
        )}
      </div>

      {health?.mode === "simulated" && wallet && (
        <>
          <h5>Demo</h5>
          <div className="c-card">
            <button className="ghost" onClick={async () => { await post("/api/sim/set-usdm", { address: wallet.address, usdm: "0.05" }); onChanged(); }}>Reset wallet to 0.05 USDM</button>
          </div>
        </>
      )}
      <p className="muted small">Connect Hermes, Claude Code, ChatGPT or Claude from <a href="#start">Get started</a>.</p>
    </aside>
  );
}

function LoanCard({ loan }: { loan: Loan }) {
  const label = loan.status === "open" ? "open" : loan.status === "repaid" ? "repaid" : loan.status === "defaulted" ? "defaulted" : loan.status;
  return (
    <div className="loan">
      <div className="kv"><span>Status</span><span className={`badge ${loan.status === "repaid" ? "badge-good" : loan.status === "defaulted" ? "badge-bad" : "badge-warn"}`}>{label}</span></div>
      <div className="loan-amounts">
        <div><div className="muted small">Borrowed</div><div className="big">{loan.amount}</div></div>
        <div><div className="muted small">Fee</div><div className="big">{loan.fee}</div></div>
        <div><div className="muted small">Owed</div><div className={`big ${loan.status === "open" ? "text-warn" : ""}`}>{loan.outstanding}</div></div>
      </div>
      {loan.status === "open" && loan.deadline && (
        <div className="deadline">
          <div className="kv"><span>Due in</span><Countdown deadline={loan.deadline} /></div>
          <DeadlineBar createdAt={loan.events.find(e => e.kind === "disbursed")?.at ?? loan.createdAt} deadline={loan.deadline} />
        </div>
      )}
      <div className="kv"><span>Pledged</span><span>{loan.collateral.items} past messages{loan.status === "repaid" ? " (released)" : loan.status === "defaulted" ? " (published)" : ""}</span></div>
      <ul className="loan-events">
        {loan.events.map((e, i) => <li key={i}><span className="event-kind">{e.kind.replace(/_/g, " ")}</span>{e.amount && <span>{e.amount}</span>}{e.tx && <TxLink hash={e.tx.hash} url={e.tx.explorerUrl} />}</li>)}
      </ul>
    </div>
  );
}

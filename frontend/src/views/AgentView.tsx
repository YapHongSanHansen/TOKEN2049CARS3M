import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Dices, Download, FilePlus2, MessageSquareText, PanelLeft, Sparkles, ThumbsDown, ThumbsUp, Wallet } from "lucide-react";
import { useFavicon } from "@/lib/hooks/use-favicon";
import { ChatApp } from "@/components/agents/chat-app";
import { ApprovalCard, type ApprovalCardAnswers } from "@/components/agents/approval-card";
import { Message, MessageAvatar, MessageContent, MessageTyping } from "@/components/agents/message";
import { MessageBubble } from "@/components/agents/message-bubble";
import { MessageScroller } from "@/components/agents/message-scroller";
import { PromptInput } from "@/components/agents/prompt-input";
import { ToolResult, type ToolResultStatus } from "@/components/agents/tool-result";
import {
  AnimatedSidebar, AnimatedSidebarContent, AnimatedSidebarFooter, AnimatedSidebarGroup, AnimatedSidebarGroupContent, AnimatedSidebarGroupLabel,
  AnimatedSidebarHeader, AnimatedSidebarInset, AnimatedSidebarMenu, AnimatedSidebarMenuButton, AnimatedSidebarMenuItem, AnimatedSidebarTrigger,
} from "@/components/motion/animated-sidebar";
import { Button } from "@/components/ui/button";
import { get, post, type ActivityEntry, type AgentStatus, type Loan, type LoanRequest, type MessagesState, type PastMessage } from "../api";
import { Countdown, DeadlineBar, ErrorNote, JsonToggle, TxLink, short } from "../components";
import { useHealth, usePoll, useSession } from "../hooks";
import { walletLabel } from "../cardano";
import { GenUI } from "../genui/library";

const SUGGESTIONS = [
  "Find me trading signals on CARSEM, I want some pocket money from Cardano DEX trades",
  "Cheapest flight from Kuala Lumpur to Singapore",
  "Cheapest hotel at Singapore Geylang",
  "Cheapest Pokemon Pack 30th Anniversary",
];
function ProviderLogo({ url }: { url: string }) {
  const favicon = useFavicon(url);
  if (!favicon.src) return <Bot />;
  return <img ref={favicon.ref} src={favicon.src} alt="" width={16} height={16} referrerPolicy="no-referrer" className="size-4 rounded-sm object-contain" />;
}
/** The agent's brain: the built-in scripted workflow, or OpenAI function calling (needs OPENAI_API_KEY on the gateway). */
const BRAINS = [
  { value: "scripted", label: "CARSEM agent", icon: <Sparkles /> },
  { value: "openai", label: "OpenAI (needs API key)", icon: <ProviderLogo url="https://openai.com" /> },
];
/** Demo controls, in the prompt box's "+" menu. */
const ACTIONS = [
  { value: "auto", label: "Trade by signal confidence", description: "The simulated DEX fill follows the signal.", icon: <Dices /> },
  { value: "win", label: "Force a winning trade", description: "Show the repay path.", icon: <ThumbsUp /> },
  { value: "loss", label: "Force a losing trade", description: "Show the top-up / default path.", icon: <ThumbsDown /> },
];
const OUTCOME_LABEL: Record<string, string> = { auto: "by signal confidence", win: "forced win", loss: "forced loss" };
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
  const [outcome, setOutcome] = useState("auto");
  const [brain, setBrain] = useState("scripted");
  // Portals (the "+" menu, the mobile sidebar sheet) render into <body>, outside this page's .beui wrapper.
  useEffect(() => { document.body.classList.add("beui"); return () => document.body.classList.remove("beui"); }, []);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1180);
  const [error, setError] = useState<string>();
  const lastId = useRef(0);

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

  async function send(message: string) {
    const text = message.trim();
    if (!text || working) return;
    setPending(text); setWorking(true); setError(undefined);
    try { await post("/agent/v1/ask?format=json", { message: text, forceOutcome: outcome === "auto" ? undefined : outcome, brain }); }
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
  const last = turns.at(-1);
  const busy = working || (last?.kind === "ask" && last.live);

  return (
    <div className={`chat-layout ${panelOpen ? "panel-open" : ""}`}>
      <ChatApp className="beui chat-shell h-[calc(100svh-52px)] rounded-none border-0 border-r" defaultOpen>
        <Sidebar history={history.data} onChanged={history.refresh} onNewChat={newChat} name={profile?.name ?? ""} wallet={profile?.wallet} />

        <AnimatedSidebarInset className="chat-main min-h-0">
          <header className="flex h-13 items-center gap-2 border-b border-border px-3">
            <AnimatedSidebarTrigger className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Toggle sidebar"><PanelLeft className="size-4" /></AnimatedSidebarTrigger>
            <span className="truncate text-sm text-muted-foreground">Your CARSEM agent · {health?.mode === "preprod" ? "Cardano preprod" : "simulated chain"}</span>
            <button type="button" onClick={() => setPanelOpen(!panelOpen)} title="Wallet and loan"
              className="ml-auto inline-flex h-8 items-center gap-2 rounded-full border border-border px-3 text-sm hover:bg-accent">
              <span className={`size-2 rounded-full ${loan?.status === "open" ? "bg-amber-400" : loan?.status === "defaulted" ? "bg-red-400" : "bg-emerald-400"}`} />
              <Wallet className="size-4 text-muted-foreground" />
              {wallet ? `${Number(wallet.USDM).toLocaleString(undefined, { maximumFractionDigits: 4 })} USDM` : "wallet"}
              {loan?.status === "open" && <span className="text-muted-foreground">· loan due</span>}
            </button>
          </header>

          {!hasThread ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 py-10">
              <div className="max-w-xl text-center">
                <h1 className="font-serif text-3xl font-semibold tracking-tight">{greeting()}, {profile?.name}</h1>
                <p className="mt-3 text-muted-foreground">Ask for trading signals or the cheapest flights, hotels and products. When something costs more than your agent holds, it asks you which past messages to pledge for a loan.</p>
              </div>
              <div className="w-full max-w-2xl">
                <PromptInput placeholder="Ask your agent…" onSubmit={value => void send(value)} loading={busy} models={BRAINS} model={brain} onModelChange={setBrain} actions={ACTIONS} onAction={setOutcome} autoFocus />
              </div>
              <div className="flex max-w-2xl flex-wrap justify-center gap-2">
                {SUGGESTIONS.map(s => <Button key={s} variant="outline" size="sm" className="h-auto whitespace-normal rounded-full py-1.5 text-left" onClick={() => void send(s)}>{s}</Button>)}
              </div>
              <p className="text-xs text-muted-foreground">Also works from Hermes, Claude Code, ChatGPT and Claude: their activity shows up here too.</p>
            </div>
          ) : (
            <>
              <MessageScroller className="min-h-0 flex-1" contentClassName="mx-auto w-full max-w-3xl px-4 py-6" followOutput busy={!!busy} label="Conversation">
                {turns.map((turn, i) => <Turn key={i} turn={turn} onAsk={m => void send(m)} />)}
                {showPending && (
                  <>
                    <UserMessage text={pending!} />
                    <AssistantMessage><MessageTyping label="Working…" /></AssistantMessage>
                  </>
                )}
                {working && !showPending && !request && <AssistantMessage><MessageTyping label="Working…" /></AssistantMessage>}
                {request && <PledgeCard request={request} history={history.data} onDone={refreshSide} />}
                {error && <AssistantMessage><MessageBubble variant="danger">{error}</MessageBubble></AssistantMessage>}
              </MessageScroller>
              <div className="mx-auto w-full max-w-3xl px-4 pb-4">
                <PromptInput placeholder="Ask your agent…" onSubmit={value => void send(value)} loading={busy} models={BRAINS} model={brain} onModelChange={setBrain} actions={ACTIONS} onAction={setOutcome} />
                <p className="px-2 pt-2 text-xs text-muted-foreground">Trade outcome: {OUTCOME_LABEL[outcome]} · change it from the + menu</p>
              </div>
            </>
          )}
        </AnimatedSidebarInset>
      </ChatApp>

      {panelOpen && <SidePanel status={status.data} loan={loan} onChanged={refreshSide} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

// ---- transcript ------------------------------------------------------------------------------

type ToolStep = { tool: string; input: any; x402: Array<{ step: string; detail: any }>; result?: any };
type Part = { kind: "text"; text: string } | { kind: "ui"; code: string } | { kind: "tool"; step: ToolStep } | { kind: "notice"; text: string; tone: "warn" | "bad" };
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
      else if (type === "ui") parts.push({ kind: "ui", code: data.code });
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

function UserMessage({ text }: { text: string }) {
  return (
    <Message from="user" animateIn>
      <MessageContent><MessageBubble variant="solid">{text}</MessageBubble></MessageContent>
    </Message>
  );
}

function AssistantMessage({ children, source }: { children: ReactNode; source?: string }) {
  return (
    <Message from="assistant" animateIn>
      <MessageAvatar><Bot className="size-4" /></MessageAvatar>
      <MessageContent className="min-w-0 flex-1">
        {source && <div className="mb-1 text-xs text-muted-foreground">{source}</div>}
        {children}
      </MessageContent>
    </Message>
  );
}

function Turn({ turn, onAsk }: { turn: TurnT; onAsk(message: string): void }) {
  const waiting = turn.kind === "ask" && turn.live && !waitingOnTool(turn.parts);
  return (
    <>
      {turn.kind === "ask" && <UserMessage text={turn.message} />}
      <AssistantMessage source={turn.kind === "app" ? `From your connected app · ${new Date(turn.at).toLocaleTimeString()}` : undefined}>
        <div className="flex flex-col gap-2.5">
          {turn.parts.map((part, i) =>
            part.kind === "text" ? <MessageBubble key={i} variant="ghost" className="px-0"><p className="font-serif text-[16.5px] leading-relaxed whitespace-pre-wrap">{part.text}</p></MessageBubble>
            : part.kind === "ui" ? <GenUI key={i} code={part.code} onAsk={onAsk} />
            : part.kind === "notice" ? <MessageBubble key={i} variant={part.tone === "bad" ? "danger" : "tint"}><strong className="block text-xs font-semibold uppercase tracking-wide">{part.tone === "bad" ? "Something went wrong" : "Your agent needs you"}</strong>{part.text}</MessageBubble>
            : <ToolRow key={i} step={part.step} />)}
          {waiting && <MessageTyping label="Thinking…" />}
        </div>
      </AssistantMessage>
    </>
  );
}

const waitingOnTool = (parts: Part[]) => { const last = parts.at(-1); return last?.kind === "tool" && last.step.result === undefined; };

function ToolRow({ step }: { step: ToolStep }) {
  const { label, meta } = describeTool(step);
  const status: ToolResultStatus = step.result === undefined ? "running" : step.result?.error ? "error" : "success";
  return (
    <ToolResult tool={step.tool.replace(/_/g, " ")} title={label} status={status} kind="request" meta={meta} collapseOnComplete>
      <div className="flex flex-col gap-2 text-sm">
        {step.x402.length > 0 && <X402Chips steps={step.x402} />}
        {step.result !== undefined && <div>{toolDetail(step.tool, step.result)}</div>}
        <JsonToggle value={{ input: step.input, result: step.result }} label="raw" />
      </div>
    </ToolResult>
  );
}

function X402Chips({ steps }: { steps: Array<{ step: string; detail: any }> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px]">
      {steps.map((s, i) => (
        <span key={i} className={`rounded-md px-2 py-0.5 ${s.step === "settled" ? "bg-emerald-500/15 text-emerald-300" : s.step === "rejected" ? "bg-red-500/15 text-red-300" : "bg-violet-500/15 text-violet-300"}`}>
          {s.step === "request" ? `HTTP ${s.detail.status}` : s.step === "offer" ? `offer ${Number(s.detail.amount) / 1e6} USDM` : s.step === "signed" ? "signed by your agent" : s.step === "pending" ? "settling…" : s.step}
          {s.step === "settled" && s.detail.transaction && <> · <TxLink hash={s.detail.transaction} /></>}
        </span>
      ))}
    </div>
  );
}

function describeTool({ tool, input, result: r }: ToolStep): { label: ReactNode; meta?: ReactNode } {
  const done = r !== undefined;
  if (r?.error) return { label: <>{tool.replace(/_/g, " ")} failed</>, meta: r.error };
  switch (tool) {
    case "carsem_status": return { label: "Checked your CARSEM account" };
    case "search_data": return { label: <>Searched CARSEM for <strong>{input.category}{input.query ? ` · ${input.query}` : ""}</strong></>, meta: done ? `${r.results.length} result(s)` : undefined };
    case "buy_data":
      if (!done) return { label: "Buying data over x402…" };
      if (r.status === "insufficient_funds") return { label: <>Hit a paywall: <strong>{r.price_usdm} USDM</strong></>, meta: `wallet holds ${r.balance_usdm}` };
      if (r.status === "delivered") return { label: <>Bought <strong>{r.listing.title}</strong></>, meta: `${r.paid_usdm} USDM` };
      if (r.status === "free") return { label: <>Read free data: <strong>{r.listing.title}</strong></> };
      return { label: <>Purchase: {r.status}</> };
    case "list_my_messages": return { label: "Read your past messages" };
    case "add_messages": return { label: <>Added {done ? r.added : "…"} message(s) to your history</> };
    case "borrow":
      if (!done) return { label: "Collateral borrowing…" };
      if (r.status === "selection_required") return { label: <>Asked you to choose messages to pledge for <strong>{r.amount_usdm} USDM</strong></> };
      return { label: <>Borrowed <strong>{r.amount_usdm} USDM</strong></>, meta: r.collateral?.split(" (")[0] };
    case "borrow_status":
      if (!done) return { label: "Waiting for you to choose…" };
      return { label: r.status === "borrowed" ? <>You approved: borrowed <strong>{r.amount_usdm} USDM</strong></> : <>Borrow request {r.status}</> };
    case "trade_signal": return { label: done ? <>Traded on the DEX: <strong className={r.pnlUsdm >= 0 ? "text-emerald-300" : "text-red-300"}>{r.outcome} {r.pnlUsdm >= 0 ? "+" : ""}{r.pnlUsdm} USDM</strong></> : "Trading on the DEX…" };
    case "my_loan": return { label: "Checked your loan" };
    case "repay_loan":
      if (!done) return { label: "Repaying over x402…" };
      if (r.status === "repaid") return { label: <>Repaid <strong>{r.paid_usdm} USDM</strong></>, meta: "your messages are unlocked" };
      if (r.status === "insufficient_funds") return { label: <>Can't repay yet</>, meta: `${r.shortfall_usdm} USDM short` };
      return { label: <>Repay: {r.status}</> };
    case "upload_data": return { label: <>Uploaded {input.category} data</> };
    case "rate_data": return { label: <>Rated data {input.useful ? "useful" : "not useful"}</> };
    case "browse_published_data": return { label: "Browsed published chats" };
    case "access_published_data": return { label: "Accessed published chats" };
    default: return { label: tool };
  }
}

function toolDetail(tool: string, r: any): ReactNode {
  if (r?.error) return <span className="text-red-300">{r.error}</span>;
  switch (tool) {
    case "buy_data":
      if (r.status === "delivered") return <>Paid over x402 <TxLink hash={r.payment_tx} url={r.payment_explorer} /> · proof of delivery <code>{short(r.delivery_hash, 10, 6)}</code> logged on chain</>;
      return r.message ?? null;
    case "search_data": return <ul className="list-disc pl-4">{r.results.slice(0, 4).map((x: any) => <li key={x.listing_id}>{x.title} · {x.free ? "free" : `${x.price_usdm} USDM`} · {x.uploader} ({x.uploader_reputation})</li>)}</ul>;
    case "borrow": case "borrow_status":
      if (r.status === "borrowed") return <>Fee {r.fee_usdm} USDM, due {r.total_due_usdm} USDM {r.deadline && <>by {new Date(r.deadline).toLocaleTimeString()}</>} · {r.collateral} {r.disburse_tx && <TxLink hash={r.disburse_tx} url={r.disburse_explorer} />}</>;
      return r.next ?? null;
    case "trade_signal": return <>{r.side} with {r.sizeAda} tADA · {r.venue} {r.payout && <TxLink hash={r.payout.tx.txHash} url={r.payout.tx.explorerUrl} />}</>;
    case "repay_loan": return r.payment_tx ? <TxLink hash={r.payment_tx} /> : null;
    default: return null;
  }
}

// ---- approval: the user chooses which past messages to pledge -----------------------------------

function PledgeCard({ request, history, onDone }: { request: LoanRequest; history?: MessagesState; onDone(): void }) {
  const [answers, setAnswers] = useState<ApprovalCardAnswers>({});
  const [status, setStatus] = useState<"pending" | "submitting" | "approved" | "rejected">("pending");
  const [error, setError] = useState<string>();
  const available = (history?.messages ?? []).filter(m => !m.state);
  const min = request.minMessagesToPledge;
  const fee = (Number(request.amount) * 0.02).toFixed(2);
  const chosen = answers.messages?.selected ?? [];
  async function act(next: "approved" | "rejected", action: () => Promise<unknown>) {
    setStatus("submitting"); setError(undefined);
    try { await action(); setStatus(next); onDone(); } catch (e) { setError((e as Error).message); setStatus("pending"); }
  }
  return (
    <AssistantMessage>
      <ApprovalCard
        title={`Collateral borrowing: ${request.amount} USDM`}
        description={<>Your agent wants to borrow {request.amount} USDM (+{fee} fee) for <strong>{request.purpose}</strong>. Choose at least {min} past messages to pledge. Only these are locked; if the loan isn't repaid in time they are published on CARSEM for others to buy.</>}
        status={status}
        answers={answers}
        onAnswersChange={setAnswers}
        questions={available.length >= min ? [{
          id: "messages", title: "Which past messages do you pledge?", multiple: true,
          options: available.map(m => ({ value: String(m.id), label: `${m.text}${m.intents.length ? `  ·  ${m.intents.join(", ")}` : ""}` })),
        }] : []}
        submitLabel={`Pledge ${chosen.length} message${chosen.length === 1 ? "" : "s"} & borrow`}
        onSubmit={a => {
          const ids = (a.messages?.selected ?? []).map(Number);
          if (ids.length < min) { setError(`Choose at least ${min} messages.`); return; }
          void act("approved", () => post("/api/loans", { requestId: request.id, messageIds: ids }));
        }}
        onReject={() => void act("rejected", () => post(`/api/loan-requests/${request.id}/decline`))}
        result={status === "approved" ? "Borrowed. Your agent is continuing." : status === "rejected" ? "Declined. Nothing was pledged." : undefined}
      >
        {available.length < min && <p className="text-sm text-amber-300">You have {available.length} past message(s); at least {min} are needed. Add your history from the sidebar (import a ChatGPT or Claude export, or add the sample chats), then choose here.</p>}
        {error && <p className="text-sm text-red-300">{error}</p>}
      </ApprovalCard>
    </AssistantMessage>
  );
}

// ---- sidebar: your past messages ----------------------------------------------------------------

function Sidebar({ history, onChanged, onNewChat, name, wallet }: { history?: MessagesState; onChanged(): Promise<void>; onNewChat(): void; name: string; wallet?: { name: string | null; id: string } }) {
  const [note, setNote] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
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
  const messages = history?.messages ?? [];
  return (
    <AnimatedSidebar variant="sidebar" collapsible="offcanvas" panelClassName="h-full" ariaLabel="Your past messages">
      <AnimatedSidebarHeader className="p-2">
        <AnimatedSidebarMenu>
          <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<FilePlus2 className="size-4" />} onSelect={onNewChat}>New chat</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
        </AnimatedSidebarMenu>
      </AnimatedSidebarHeader>
      <AnimatedSidebarContent>
        <AnimatedSidebarGroup>
          <AnimatedSidebarGroupLabel>Your past messages · {messages.length}</AnimatedSidebarGroupLabel>
          <AnimatedSidebarGroupContent>
            <AnimatedSidebarMenu>
              {messages.map((m: PastMessage) => (
                <AnimatedSidebarMenuItem key={m.id}>
                  <AnimatedSidebarMenuButton icon={<MessageSquareText className="size-4" />} badge={m.state ? <span className="text-[10px] uppercase text-amber-300">{m.state}</span> : undefined}>
                    <span className="block truncate" title={m.text}>{m.text}</span>
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              ))}
              {!messages.length && <li className="px-2 py-1 text-xs text-muted-foreground">No messages yet. They come from your AI apps, or add them below.</li>}
            </AnimatedSidebarMenu>
          </AnimatedSidebarGroupContent>
        </AnimatedSidebarGroup>
        <AnimatedSidebarGroup>
          <AnimatedSidebarGroupLabel>Add history</AnimatedSidebarGroupLabel>
          <AnimatedSidebarGroupContent>
            <AnimatedSidebarMenu>
              <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<Download className="size-4" />} onSelect={() => fileInput.current?.click()}>Import ChatGPT / Claude export</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
              <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<FilePlus2 className="size-4" />} onSelect={() => void run(() => post("/api/me/messages/sample"))}>Add sample chats (demo)</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
            </AnimatedSidebarMenu>
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void run(() => importFile(f)); e.target.value = ""; }} />
            {note && <p className="px-2 pt-1 text-xs text-muted-foreground">{note}</p>}
          </AnimatedSidebarGroupContent>
        </AnimatedSidebarGroup>
      </AnimatedSidebarContent>
      <AnimatedSidebarFooter className="p-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-full bg-foreground text-sm font-semibold text-background">{name.slice(0, 1).toUpperCase()}</span>
          <span className="min-w-0 text-sm">
            <span className="block truncate font-medium">{name}</span>
            <span className="block truncate text-xs text-emerald-300" title={wallet?.id}>✓ {walletLabel(wallet?.name ?? null)} {wallet ? short(wallet.id, 10, 4) : ""} · DID verified</span>
          </span>
        </div>
      </AnimatedSidebarFooter>
    </AnimatedSidebar>
  );
}

// ---- side panel: wallet and loan -------------------------------------------------------------------

function SidePanel({ status, loan, onChanged, onClose }: { status?: AgentStatus; loan?: Loan; onChanged(): void; onClose(): void }) {
  const health = useHealth();
  const wallet = status?.wallet;
  const missing = loan?.status === "open" && wallet ? Math.max(0, Number(loan.outstanding) - Number(wallet.USDM)) : 0;
  return (
    <aside className="c-panel">
      <div className="kv"><h5>Wallet</h5><Button variant="link" size="sm" className="h-auto p-0 text-muted-foreground" onClick={onClose}>hide</Button></div>
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
            <Button size="sm" onClick={async () => { await post("/api/sim/faucet", { address: wallet.address, usdm: missing.toFixed(6) }); onChanged(); }}>Top up {missing.toFixed(2)} USDM</Button>
            <p className="muted small" style={{ margin: "8px 0 0" }}>Then ask: "repay my loan".</p>
          </div>
        )}
      </div>

      {health?.mode === "simulated" && wallet && (
        <>
          <h5>Demo</h5>
          <div className="c-card">
            <Button variant="outline" size="sm" onClick={async () => { await post("/api/sim/set-usdm", { address: wallet.address, usdm: "0.05" }); onChanged(); }}>Reset wallet to 0.05 USDM</Button>
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

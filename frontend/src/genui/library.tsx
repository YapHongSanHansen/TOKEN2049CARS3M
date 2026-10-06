/**
 * The CARSEM OpenUI component library for the browser: the schemas from @carsem/shared/genui with
 * React renderers, and <GenUI>, which renders a program the agent wrote.
 */
import { createLibrary, defineComponent, Renderer, useIsStreaming, useTriggerAction, type ActionEvent, type ActionPlan } from "@openuidev/react-lang";
import { buildUiLibrary, type UiName } from "@carsem/shared/genui";
import { Button } from "@/components/ui/button";
import { Badge, TxLink } from "../components";

type Rendered = { props: Record<string, any>; renderNode: (node: unknown) => React.ReactNode };
const tone = (t?: string) => (t && t !== "default" ? `gu-${t}` : "");

const RENDERERS: Partial<Record<UiName, (r: Rendered) => React.ReactNode>> = {
  Stack: ({ props, renderNode }) => <div className="gu-stack">{renderNode(props.children)}</div>,
  Actions: ({ props, renderNode }) => <div className="gu-actions">{renderNode(props.children)}</div>,
  Text: ({ props }) => <p className={`gu-text ${tone(props.tone)}`}>{props.text}</p>,
  Stat: ({ props }) => <div className="gu-stat"><span className="gu-label">{props.label}</span><strong className={tone(props.tone)}>{props.value}</strong></div>,
  Button: ({ props }) => {
    const trigger = useTriggerAction();
    const streaming = useIsStreaming();
    return (
      <Button variant={props.variant === "secondary" ? "outline" : "default"} size="sm" disabled={streaming}
        onClick={() => void trigger(props.label, undefined, (props.action ?? undefined) as ActionPlan | undefined)}>{props.label}</Button>
    );
  },
  DataCard: ({ props }) => (
    <article className={`gu-card gu-data ${props.locked ? "locked" : ""}`}>
      <header><h4>{props.title}</h4>{props.locked ? <Badge tone="warn">LOCKED</Badge> : <Badge tone="good">DELIVERED</Badge>}</header>
      <p className="gu-meta">{props.meta}</p>
      <dl className="gu-rows">
        {(props.rows as Array<{ label: string; value: string }>).map(r => <div key={r.label}><dt>{r.label}</dt><dd className={props.locked ? "hidden" : ""}>{props.locked ? "••••" : r.value}</dd></div>)}
      </dl>
      {props.tx && <p className="gu-meta">Paid over x402 <TxLink hash={props.tx.hash} url={props.tx.url ?? undefined} /></p>}
    </article>
  ),
  Paywall: ({ props }) => (
    <article className="gu-card gu-paywall">
      <header><h4>{props.title}</h4><Badge tone="x402">HTTP 402</Badge></header>
      <div className="gu-stats">
        <div className="gu-stat"><span className="gu-label">Price</span><strong>{props.price} USDM</strong></div>
        <div className="gu-stat"><span className="gu-label">Agent wallet</span><strong className="gu-bad">{props.balance} USDM</strong></div>
        <div className="gu-stat"><span className="gu-label">Short by</span><strong>{props.shortfall} USDM</strong></div>
      </div>
    </article>
  ),
  LoanCard: ({ props }) => (
    <article className={`gu-card gu-loan ${props.status}`}>
      <header><h4>Loan {props.loanId}</h4><Badge tone={props.status === "repaid" ? "good" : props.status === "defaulted" ? "bad" : "warn"}>{props.status}</Badge></header>
      <div className="gu-stats">
        <div className="gu-stat"><span className="gu-label">Borrowed</span><strong>{props.amount} USDM</strong></div>
        <div className="gu-stat"><span className="gu-label">Fee</span><strong>{props.fee} USDM</strong></div>
        <div className="gu-stat"><span className="gu-label">Due</span><strong>{props.due} USDM</strong></div>
        {props.deadline && <div className="gu-stat"><span className="gu-label">Deadline</span><strong>{new Date(props.deadline).toLocaleTimeString()}</strong></div>}
      </div>
      <p className="gu-meta">{props.collateral}</p>
    </article>
  ),
  TradeCard: ({ props }) => (
    <article className={`gu-card gu-trade ${props.outcome}`}>
      <header><h4>{props.side} {props.pair}</h4><Badge tone={props.outcome === "win" ? "good" : "bad"}>{props.outcome}</Badge></header>
      <div className="gu-stats">
        <div className="gu-stat"><span className="gu-label">P&amp;L</span><strong className={props.outcome === "win" ? "gu-good" : "gu-bad"}>{props.pnl} USDM</strong></div>
        <div className="gu-stat"><span className="gu-label">Venue</span><strong>{props.venue}</strong></div>
      </div>
      {props.tx && <p className="gu-meta">Payout <TxLink hash={props.tx.hash} url={props.tx.url ?? undefined} /></p>}
    </article>
  ),
  Receipt: ({ props }) => (
    <article className="gu-card gu-receipt">
      <header><h4>{props.title}</h4><strong>{props.amount}</strong></header>
      {props.tx && <p className="gu-meta">Settled <TxLink hash={props.tx.hash} url={props.tx.url ?? undefined} /></p>}
    </article>
  ),
};

type Library = Parameters<typeof Renderer>[0]["library"];
const library = buildUiLibrary<Library>(
  ((config: { name: string; description: string; props: unknown; component: unknown }) => defineComponent(config as never)) as never,
  ((definition: { components: unknown[]; root: string }) => createLibrary(definition as never)) as never,
  Object.fromEntries(Object.entries(RENDERERS).map(([name, render]) => [name, (args: Rendered) => render(args)])),
);

/** Renders a program the agent wrote. A button press becomes the user's next message via `onAsk`. */
export function GenUI({ code, streaming = false, onAsk }: { code: string; streaming?: boolean; onAsk(message: string): void }) {
  const onAction = (event: ActionEvent) => {
    if (event.type === "open_url" && typeof event.params?.url === "string") window.open(event.params.url, "_blank", "noopener");
    else if (event.humanFriendlyMessage) onAsk(event.humanFriendlyMessage);
  };
  return <div className="gu"><Renderer response={code} library={library} isStreaming={streaming} onAction={onAction} publishObservability={false} /></div>;
}

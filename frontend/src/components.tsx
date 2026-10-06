import { useState, type ReactNode } from "react";
import { useNow, useTxUrl } from "./hooks";

export const short = (value: string, head = 8, tail = 6) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value);

export function TxLink({ hash, url, label }: { hash: string; url?: string; label?: string }) {
  const txUrl = useTxUrl();
  return (
    <a className="tx" href={url ?? txUrl(hash)} target="_blank" rel="noreferrer" title={hash}>
      {label ?? short(hash, 6, 4)} <span aria-hidden>↗</span>
    </a>
  );
}

export function AddressLink({ address }: { address: string }) {
  const href = address.startsWith("addr_test1sim") ? `/api/sim/balances/${address}` : `https://preprod.cardanoscan.io/address/${address}`;
  return <a className="tx" href={href} target="_blank" rel="noreferrer" title={address}>{short(address, 12, 6)} <span aria-hidden>↗</span></a>;
}

type Tone = "neutral" | "good" | "bad" | "warn" | "info" | "x402";
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export const loanTone = (status: string): Tone =>
  status === "repaid" ? "good" : status === "defaulted" ? "bad" : status === "open" ? "warn" : "neutral";

export function Countdown({ deadline }: { deadline: string }) {
  const now = useNow();
  const left = Math.max(0, Math.round((Date.parse(deadline) - now) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return <span className={`countdown ${left <= 30 ? "urgent" : ""}`}>{left === 0 ? "due now" : `${mm}:${ss}`}</span>;
}

export function DeadlineBar({ createdAt, deadline }: { createdAt: string; deadline: string }) {
  const now = useNow();
  const total = Date.parse(deadline) - Date.parse(createdAt);
  const used = Math.min(1, Math.max(0, (now - Date.parse(createdAt)) / total));
  return <div className="bar"><div className={`bar-fill ${used > 0.85 ? "urgent" : ""}`} style={{ width: `${used * 100}%` }} /></div>;
}

export function Panel({ title, actions, children, className = "" }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head"><h2>{title}</h2>{actions && <div className="panel-actions">{actions}</div>}</header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function JsonToggle({ value, label = "details" }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="json-toggle">
      <button className="link-button" onClick={() => setOpen(!open)}>{open ? "hide" : label}</button>
      {open && <pre className="json">{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error?: string }) {
  return error ? <p className="error-note">{error}</p> : null;
}

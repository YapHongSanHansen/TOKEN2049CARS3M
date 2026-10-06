import { useEffect, useState } from "react";
import { DEMO_AGENT, DEMO_USER, del, get, post, type BundleStats, type User } from "../api";
import { Badge, Empty, ErrorNote, Panel, short } from "../components";
import { usePoll } from "../hooks";

const SAMPLE = [
  "My girlfriend's birthday on 30th Sept, looking for a necklace under $200",
  "Book a flight to Singapore for TOKEN2049 and a hotel near Marina Bay",
  "Remind me to pay rent to my landlord John on the 1st",
  "Call Sarah at +60 12-345 6789 about the job interview on Friday",
  "Thinking of buying a new iPhone if the price drops below 3000 RM",
  "My doctor said I should keep taking the medication",
  "Dinner reservation for two at 8pm, somewhere near 12 Jalan Ampang",
].join("\n");

const BUNDLE_STATUS: Record<string, string> = {
  held: "Held under your consent. Not pledged, not for sale.",
  pledged: "Pledged as collateral for your agent's open loan.",
  listed: "Listed for sale: a loan against it defaulted.",
  revoked: "Revoked. No longer usable.",
};

export function DataView() {
  const user = usePoll(() => get<User>(`/api/users/${DEMO_USER}`), 4000);
  const [text, setText] = useState(SAMPLE);
  const [preview, setPreview] = useState<{ before: string[]; after: string[]; stats: BundleStats }>();
  const [allowSale, setAllowSale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const consent = user.data?.consent;
  const active = consent?.status === "active";

  // Live preview: what would leave your device, before anything is stored.
  useEffect(() => {
    const chats = text.split("\n").filter(line => line.trim());
    if (!chats.length) { setPreview(undefined); return; }
    const timer = setTimeout(() => { post<typeof preview>("/api/redact/preview", { chats }).then(setPreview).catch(() => {}); }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => { if (consent?.allowSaleWhileOpen !== undefined) setAllowSale(consent.allowSaleWhileOpen); }, [consent?.allowSaleWhileOpen]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await action(); await user.refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const grant = () => act(() => post(`/api/users/${DEMO_USER}/consent`, { chats: text.split("\n"), agentId: DEMO_AGENT, allowSaleWhileOpen: allowSale }));
  const revoke = () => act(() => del(`/api/users/${DEMO_USER}/consent`));

  return (
    <div className="data-grid">
      <Panel title="Your chats → redacted bundle" className="redaction-panel">
        <p className="muted">Names, dates, contact details, addresses and account numbers are stripped. Health topics and credentials are withheld entirely. Only coarse intent signals remain.</p>
        <div className="redaction">
          <div>
            <h3>Before (stays with you)</h3>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={12} spellCheck={false} />
          </div>
          <div>
            <h3>After (what the bundle holds)</h3>
            <ul className="after-list">
              {preview?.after.map((line, i) => <li key={i} className={line.startsWith("[WITHHELD") ? "withheld" : ""}>{highlight(line)}</li>) ?? <Empty>Type some messages.</Empty>}
            </ul>
          </div>
        </div>
        {preview && (
          <div className="stat-chips">
            {Object.entries(preview.stats.replacements).map(([k, v]) => <span key={k} className="chip static">{k.replace("withheld:", "withheld · ")} ×{v}</span>)}
            {Object.keys(preview.stats.intents).map(k => <span key={k} className="chip static intent">{k}</span>)}
          </div>
        )}
      </Panel>

      <div className="side-column">
        <Panel title="Consent" actions={consent && <Badge tone={active ? "good" : "neutral"}>{consent.status === "none" ? "not given" : consent.status}</Badge>}>
          <label className="toggle">
            <input type="checkbox" checked={active} disabled={busy} onChange={e => (e.target.checked ? grant() : revoke())} />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
            <span><strong>Allow my agent to borrow against my redacted chat data</strong></span>
          </label>
          <label className="check">
            <input type="checkbox" checked={allowSale} disabled={busy} onChange={e => setAllowSale(e.target.checked)} />
            Allow enterprises to buy the bundle while a loan is open. Proceeds repay the loan first, and the rest goes to you.
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy} onClick={grant}>{active ? "Update bundle" : "Opt in"}</button>
            {active && <button className="ghost danger" disabled={busy} onClick={revoke}>Revoke</button>}
          </div>
          <ErrorNote error={error} />
          <ul className="fine-print">
            <li>Opt-in only, and you can revoke it any time (except while a loan is open against the bundle).</li>
            <li>Raw chats are discarded after redaction. Only the encrypted redacted bundle is stored.</li>
            <li>Agent <code>{DEMO_AGENT}</code> may borrow up to the loan limit against it.</li>
          </ul>
        </Panel>

        <Panel title="Your bundle">
          {consent?.bundle ? (
            <>
              <div className="kv"><span>Status</span><Badge tone={consent.bundle.status === "listed" ? "bad" : consent.bundle.status === "pledged" ? "warn" : "neutral"}>{consent.bundle.status}</Badge></div>
              <p className="muted small">{BUNDLE_STATUS[consent.bundle.status]}</p>
              <div className="kv"><span>Messages</span><span>{consent.bundle.stats.messages} ({consent.bundle.stats.withheld} withheld)</span></div>
              <div className="kv"><span>collateral_ref</span><code title={consent.bundle.collateralRef}>{short(consent.bundle.collateralRef, 10, 6)}</code></div>
              <div className="kv"><span>Your data earnings</span><strong>{user.data?.earnings} tUSDM</strong></div>
            </>
          ) : <Empty>No bundle yet. Opt in to create one.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

function highlight(line: string) {
  return line.split(/(\[[A-Z]+(?:: [a-z_]+)?\])/g).map((part, i) => (/^\[[A-Z]/.test(part) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>));
}

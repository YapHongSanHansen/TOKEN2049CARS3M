import { useState } from "react";
import { get, post, type Bid, type EnterpriseWallet, type Listing, type Sale } from "../api";
import { Badge, Empty, ErrorNote, Panel, TxLink } from "../components";
import { usePoll } from "../hooks";

interface Purchase {
  enterprise: string; bundleId: string; price: number; payment: { tx: string; explorerUrl: string }; messages: string[];
  loan?: { id: string; before: { status: string; outstanding: string }; after: { status: string; outstanding: string } };
  steps: Array<{ step: string; detail: Record<string, unknown> }>;
}

export function MarketView() {
  const listings = usePoll(() => get<Listing[]>("/api/market/bundles"), 3000);
  const bids = usePoll(() => get<Bid[]>("/api/market/bids"), 10000);
  const wallets = usePoll(() => get<EnterpriseWallet[]>("/agent/enterprises"), 4000);
  const sales = usePoll(() => get<Sale[]>("/api/market/sales"), 4000);
  const [buying, setBuying] = useState<string>();
  const [purchase, setPurchase] = useState<Purchase>();
  const [error, setError] = useState<string>();

  async function buy(enterprise: string, bundleId: string) {
    setBuying(`${enterprise}:${bundleId}`); setError(undefined);
    try {
      setPurchase(await post<Purchase>(`/agent/enterprises/${enterprise}/buy`, { bundleId }));
      await Promise.all([listings.refresh(), wallets.refresh(), sales.refresh()]);
    } catch (e) { setError((e as Error).message); }
    finally { setBuying(undefined); }
  }

  return (
    <div className="market-grid">
      <div className="market-main">
        <Panel title="Redacted bundles for sale">
          <p className="muted">A bundle appears here when its owner allows sales while a loan is open (proceeds repay the loan), or when a loan against it defaults. Buyers pay over x402 and receive redacted lines only.</p>
          {listings.data?.length ? listings.data.map(l => (
            <article key={l.id} className="listing">
              <header>
                <code>{l.id}</code>
                <Badge tone={l.status === "listed" ? "bad" : "warn"}>{l.status === "listed" ? "defaulted" : "loan open"}</Badge>
                {l.loan && <span className="muted small">loan {l.loan.id} · {l.loan.status} · {l.loan.outstanding} tUSDM outstanding</span>}
              </header>
              <ul className="after-list compact">{l.preview.map((line, i) => <li key={i}>{line}</li>)}</ul>
              <div className="stat-chips">
                <span className="chip static">{l.stats.messages} messages</span>
                {Object.keys(l.stats.intents).map(k => <span key={k} className="chip static intent">{k}</span>)}
              </div>
              <div className="button-row">
                {l.offers.map(o => (
                  <button key={o.bidId} className="primary" disabled={!!buying} onClick={() => buy(o.enterprise, l.id)}>
                    {buying === `${o.enterprise}:${l.id}` ? "Paying over x402…" : `Buy as ${o.enterprise} · ${o.price} tUSDM`}
                  </button>
                ))}
                {l.soldTo.length > 0 && <span className="muted small">sold to {l.soldTo.join(", ")}</span>}
              </div>
            </article>
          )) : <Empty>Nothing for sale. Bundles show up when a loan defaults, or while a loan is open if the owner allows it.</Empty>}
          <ErrorNote error={error} />
        </Panel>

        {purchase && (
          <Panel title={`${purchase.enterprise} bought ${purchase.bundleId}`} actions={<button className="link-button" onClick={() => setPurchase(undefined)}>close</button>}>
            <div className="x402-chips">
              {purchase.steps.map((s, i) => <span key={i} className={`chip-x402 ${s.step}`}>{s.step === "offer" ? `offer ${Number(s.detail.amount) / 1e6} tUSDM` : s.step === "request" ? `HTTP ${s.detail.status}` : s.step}</span>)}
              <TxLink hash={purchase.payment.tx} url={purchase.payment.explorerUrl} />
            </div>
            {purchase.loan && (
              <p>Loan <code>{purchase.loan.id}</code>: {purchase.loan.before.status}, {purchase.loan.before.outstanding} tUSDM outstanding → <strong>{purchase.loan.after.status}, {purchase.loan.after.outstanding} tUSDM</strong></p>
            )}
            <h3>Delivered ({purchase.messages.length} redacted lines)</h3>
            <ul className="after-list compact">{purchase.messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </Panel>
        )}
      </div>

      <div className="side-column">
        <Panel title="Enterprise bids">
          <table>
            <thead><tr><th>Buyer</th><th>Bid</th><th>Wallet</th></tr></thead>
            <tbody>
              {(bids.data ?? []).map(b => (
                <tr key={b.id}><td>{b.enterprise}</td><td>{b.priceUsdm} tUSDM</td><td className="muted">{wallets.data?.find(w => w.enterprise === b.enterprise)?.tUSDM ?? "…"}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Sales">
          {sales.data?.length ? (
            <ul className="feed compact">
              {sales.data.map(s => (
                <li key={s.id}>
                  <span>{s.enterprise}</span><span>{s.price} tUSDM</span>
                  <span className="muted small">{s.loanId ? `${s.appliedToLoan} → loan · ${s.toUser} → owner` : `${s.toUser} → owner`}</span>
                  <TxLink hash={s.paymentTx} />
                </li>
              ))}
            </ul>
          ) : <Empty>No sales yet.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

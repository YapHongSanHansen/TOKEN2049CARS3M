import { useMemo, useState } from "react";
import { get, post, type Listing, type MarketItem, type Sale } from "../api";
import { Badge, Empty, ErrorNote, Panel, TxLink, short } from "../components";
import { usePoll, useSession } from "../hooks";
import { Button } from "@/components/ui/button";
import { DaisyMarket, type PetalDataset } from "../daisy/DaisyMarket";

interface Bid { id: string; enterprise: string; priceUsdm: number; dataAmount: number }
interface Result { title: string; messages: string[]; tx?: string; txUrl?: string; loan?: { id: string; before: { status: string; outstanding: string }; after: { status: string; outstanding: string } } }

const FILTERS = [
  { id: "all", label: "All" },
  { id: "signal", label: "Trading signals" },
  { id: "flight", label: "Live flight tickets" },
  { id: "hotel", label: "Hotel prices" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];
const ORDER = ["signal", "flight", "hotel"];
const CATEGORY_LABEL: Record<string, string> = { signal: "Trading signals", flight: "Live flight tickets", hotel: "Hotel prices" };
const ICONS: Record<string, string> = { signal: "↗", flight: "✈\uFE0E", hotel: "⌂" };

/**
 * The data market: one daisy per seller. Petals are the seller's current (paid) datasets, fallen
 * petals the older free ones, and the centre their reputation. Click a petal for the data.
 */
export function MarketView() {
  const { key } = useSession();
  const market = usePoll(() => get<MarketItem[]>("/api/data/market"), 5000, [key]);
  const [filter, setFilter] = useState<Filter>("all");
  const sellers = useMemo(() => {
    const bySeller = new Map<string, { uploader: MarketItem["uploader"]; items: MarketItem[] }>();
    for (const item of market.data ?? []) {
      if (filter !== "all" && item.category !== filter) continue;
      const entry = bySeller.get(item.uploader.id) ?? { uploader: item.uploader, items: [] };
      entry.items.push(item);
      bySeller.set(item.uploader.id, entry);
    }
    return [...bySeller.values()].sort((a, b) => ORDER.indexOf(a.items[0].category) - ORDER.indexOf(b.items[0].category) || b.uploader.reputation - a.uploader.reputation);
  }, [market.data, filter]);

  return (
    <div className="mk">
      <div className="mk-header">
        <h1>Market</h1>
        <Button variant="ghost" size="icon" className="mk-refresh" onClick={() => void market.refresh()} aria-label="Refresh" title="Refresh">↻</Button>
      </div>
      <p className="muted">Each daisy is a seller. Petals are their fresh datasets (paid over x402); fallen petals are older ones, free. The centre is their reputation.</p>
      <nav className="mk-pills" aria-label="Categories">
        {FILTERS.map(f => <Button key={f.id} variant={f.id === filter ? "default" : "outline"} size="sm" className="rounded-full" onClick={() => setFilter(f.id)}>{f.label}</Button>)}
      </nav>
      <ErrorNote error={market.error} />
      <div className="mk-grid mk-sellers">
        {sellers.map(s => <SellerCard key={s.uploader.id} uploader={s.uploader} items={s.items} onUnlocked={() => void market.refresh()} />)}
      </div>
      {market.data && !sellers.length && <Empty>Nothing here yet.</Empty>}
      <LoanData />
    </div>
  );
}

const toPetal = (item: MarketItem): PetalDataset => ({
  id: item.id, title: item.title, uploadedAt: item.uploadedAt, price: item.free ? "Free" : `${item.price} USDM`,
  description: "", preview: "", ...(item.free ? { archivedAt: item.uploadedAt } : {}),
});

function SellerCard({ uploader, items, onUnlocked }: { uploader: MarketItem["uploader"]; items: MarketItem[]; onUnlocked(): void }) {
  const { profile } = useSession();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<{ id: string; text: string }>();
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const active = useMemo(() => items.filter(i => !i.free).map(toPetal), [items]);
  const archived = useMemo(() => items.filter(i => i.free).map(toPetal), [items]);
  const categories = [...new Set(items.map(i => i.category))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  const unlock = async (id: string) => {
    setBusy(id); setNote(undefined);
    try {
      const r = await post<{ status?: string; error?: string; message?: string; balance_usdm?: string }>("/agent/v1/tools/buy_data", { listing_id: id });
      if (r.status === "delivered") onUnlocked();
      else if (r.status === "insufficient_funds") setNote({ id, text: `Your agent holds ${r.balance_usdm} USDM. Ask it in My agent: it can borrow against your past messages.` });
      else setNote({ id, text: r.error ?? r.message ?? `Not unlocked (${r.status})` });
    } catch (e) { setNote({ id, text: (e as Error).message }); } finally { setBusy(undefined); }
  };

  return (
    <article className="mk-card mk-seller">
      <header className="mk-head">
        <span className={`mk-icon mk-${categories[0]}`} aria-hidden>{ICONS[categories[0]]}</span>
        <div className="mk-seller-id">
          <h3>{uploader.name}</h3>
          <span className="muted small">{categories.map(c => CATEGORY_LABEL[c]).join(" · ")} · {active.length} current · {archived.length} free</span>
          {uploader.address && <span className="mk-by" title={uploader.address}>{short(uploader.address, 12, 6)}</span>}
        </div>
      </header>
      <DaisyMarket
        active={active} archived={archived} reputation={uploader.reputation * 100} label={`Datasets by ${uploader.name}`} className="mk-daisy"
        renderDetails={d => {
          const item = byId.get(d.id);
          if (!item) return null;
          return (
            <>
              <dl className="mk-rows">
                {rowsOf(item).map(([label, value, tone]) => (
                  <div key={label}><dt>{label}</dt><dd className={item.unlocked ? tone : "hidden"}>{item.unlocked ? value : "••••"}</dd></div>
                ))}
              </dl>
              {note?.id === d.id && <p className="mk-note">{note.text} {note.text.startsWith("Your agent") && <a href="#agent">Open My agent</a>}</p>}
            </>
          );
        }}
        renderActions={d => {
          const item = byId.get(d.id);
          if (!item || item.free) return null;
          if (item.unlocked) return <Badge tone="info">UNLOCKED</Badge>;
          return profile?.onboarded
            ? <Button size="sm" className="mk-unlock" disabled={!!busy} onClick={() => void unlock(d.id)}>{busy === d.id ? "Paying…" : "Unlock · x402"}</Button>
            : <a className="mk-unlock small" href="#start">Verify to unlock</a>;
        }}
      />
    </article>
  );
}

type Row = [label: string, value: string, tone?: string];
function rowsOf({ category, data }: MarketItem): Row[] {
  const d = (data ?? {}) as Record<string, any>;
  switch (category) {
    case "signal": return [
      ["Direction", String(d.direction ?? "").toUpperCase(), d.direction === "long" ? "up" : "down"],
      ["Confidence", `${Math.round(Number(d.confidence) * 100)}%`],
      ["Horizon", `${d.horizonMinutes} min`],
    ];
    case "flight": return [
      ["Departs", d.date ? new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : ""],
      ["Fare", `${d.currency} ${d.price}`],
    ];
    case "hotel": return [
      ["Per night", `${d.currency} ${d.pricePerNight}`],
      ["Rating", `${d.rating} / 5`],
    ];
    default: return [];
  }
}

/** Chat bundles from loans: sold privately while a loan is open, published after a default. Shown only when there are some. */
function LoanData() {
  const { key, profile } = useSession();
  const listings = usePoll(() => get<Listing[]>("/api/market/bundles"), 3000, [key]);
  const bids = usePoll(() => get<Bid[]>("/api/market/bids"), 10000);
  const wallets = usePoll(() => get<Array<{ enterprise: string; tUSDM: string }>>("/agent/enterprises"), 4000);
  const sales = usePoll(() => get<Sale[]>("/api/market/sales"), 4000);
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const refresh = () => Promise.all([listings.refresh(), wallets.refresh(), sales.refresh()]);

  async function act(id: string, action: () => Promise<Result>) {
    setBusy(id); setError(undefined);
    try { setResult(await action()); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  }
  const buyAsEnterprise = (enterprise: string, bundleId: string) => act(`${enterprise}:${bundleId}`, async () => {
    const r = await post<{ messages: string[]; payment: { tx: string; explorerUrl: string }; loan?: Result["loan"] }>(`/agent/enterprises/${enterprise}/buy`, { bundleId });
    return { title: `${enterprise} bought ${bundleId}`, messages: r.messages, tx: r.payment.tx, txUrl: r.payment.explorerUrl, loan: r.loan };
  });
  const accessWithMyAgent = (bundleId: string) => act(`me:${bundleId}`, async () => {
    const r = await post<{ status?: string; error?: string; bundle?: { messages: string[] }; payment_tx?: string }>("/agent/v1/tools/access_published_data", { bundle_id: bundleId });
    if (r.status !== "accessed") throw new Error(r.error ?? "Access failed");
    return { title: `Your agent accessed ${bundleId}`, messages: r.bundle!.messages, tx: r.payment_tx };
  });

  const published = (listings.data ?? []).filter(l => l.status === "published");
  const pledged = (listings.data ?? []).filter(l => l.status === "pledged");
  if (!published.length && !pledged.length) return null;

  return (
    <section className="mk-loan-data">
    <h2 className="mk-section">Chat data from loans</h2>
    <div className="market-grid">
      <div className="market-main">
        <Panel title="Published chats (loan defaulted)">
          <p className="muted">When an agent doesn't repay, its user's redacted chats are published here. Any verified CARSEM user can access them for a fee, and they keep selling.</p>
          {published.length ? published.map(l => (
            <BundleCard key={l.id} listing={l}>
              {l.publicAccess && (l.publicAccess.isYours ? <span className="muted small">This is your data.</span>
                : l.publicAccess.youOwnIt ? <span className="muted small">You have access.</span>
                : profile?.onboarded ? <button className="primary" disabled={!!busy} onClick={() => accessWithMyAgent(l.id)}>{busy === `me:${l.id}` ? "Paying over x402…" : `Access with my agent · ${l.publicAccess.price} USDM`}</button>
                : <a href="#start" className="small">Verify to access</a>)}
              {l.enterpriseOffers.map(o => <button key={o.bidId} className="ghost" disabled={!!busy} onClick={() => buyAsEnterprise(o.enterprise, l.id)}>{busy === `${o.enterprise}:${l.id}` ? "Paying…" : `Buy as ${o.enterprise} · ${o.price}`}</button>)}
              {l.publicAccess && <span className="muted small">{l.publicAccess.buyers} user(s) accessed</span>}
            </BundleCard>
          )) : <Empty>Nothing published. Chats appear here only after a loan defaults.</Empty>}
        </Panel>

        <Panel title="Private enterprise sales (loan open)">
          <p className="muted">While a loan is open, enterprises can buy the locked chats privately (if the owner allowed it). The proceeds repay the loan, and the rest goes to the owner.</p>
          {pledged.length ? pledged.map(l => (
            <BundleCard key={l.id} listing={l}>
              {l.enterpriseOffers.map(o => <button key={o.bidId} className="primary" disabled={!!busy} onClick={() => buyAsEnterprise(o.enterprise, l.id)}>{busy === `${o.enterprise}:${l.id}` ? "Paying over x402…" : `Buy as ${o.enterprise} · ${o.price} USDM`}</button>)}
              {l.soldTo.length > 0 && <span className="muted small">sold to {l.soldTo.join(", ")}</span>}
            </BundleCard>
          )) : <Empty>No open loans with private sales allowed.</Empty>}
        </Panel>
        <ErrorNote error={error} />

        {result && (
          <Panel title={result.title} actions={<button className="link-button" onClick={() => setResult(undefined)}>close</button>}>
            {result.tx && <p>Paid over x402 <TxLink hash={result.tx} url={result.txUrl} /></p>}
            {result.loan && <p>Loan <code>{result.loan.id}</code>: {result.loan.before.status}, {result.loan.before.outstanding} USDM outstanding → <strong>{result.loan.after.status}, {result.loan.after.outstanding} USDM</strong></p>}
            <h3>Delivered ({result.messages.length} redacted lines)</h3>
            <ul className="after-list compact">{result.messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </Panel>
        )}
      </div>

      <div className="side-column">
        <Panel title="Enterprise bids">
          <table>
            <thead><tr><th>Buyer</th><th>Bid</th><th>Wallet</th></tr></thead>
            <tbody>
              {(bids.data ?? []).map(b => <tr key={b.id}><td>{b.enterprise}</td><td>{b.priceUsdm} USDM</td><td className="muted">{wallets.data?.find(w => w.enterprise === b.enterprise)?.tUSDM ?? "…"}</td></tr>)}
            </tbody>
          </table>
        </Panel>
        <Panel title="Sales">
          {sales.data?.length ? (
            <ul className="feed compact">
              {sales.data.map(s => (
                <li key={s.id}>
                  <span>{s.enterprise ?? "user"}</span><span>{s.price} USDM</span>
                  <span className="muted small">{[Number(s.appliedToLoan) > 0 && `${s.appliedToLoan} → loan`, Number(s.toUser) > 0 && `${s.toUser} → owner`, Number(s.toPlatform) > 0 && `${s.toPlatform} → platform`].filter(Boolean).join(" · ")}</span>
                  <TxLink hash={s.paymentTx} />
                </li>
              ))}
            </ul>
          ) : <Empty>No sales yet.</Empty>}
        </Panel>
      </div>
    </div>
    </section>
  );
}

function BundleCard({ listing: l, children }: { listing: Listing; children: React.ReactNode }) {
  return (
    <article className="listing">
      <header>
        <code>{l.id}</code>
        <Badge tone={l.status === "published" ? "bad" : "warn"}>{l.status === "published" ? "published" : "loan open"}</Badge>
        {l.loan && <span className="muted small">loan {l.loan.id} · {l.loan.status} · {l.loan.outstanding} USDM outstanding</span>}
      </header>
      <ul className="after-list compact">{l.preview.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <div className="stat-chips">
        <span className="chip static">{l.stats.messages} items</span>
        {Object.keys(l.stats.intents).map(k => <span key={k} className="chip static intent">{k}</span>)}
      </div>
      <div className="button-row">{children}</div>
    </article>
  );
}

import { useEffect, useState } from "react";
import { get, type Health } from "./api";
import { HealthContext, usePoll } from "./hooks";
import { AgentView } from "./views/AgentView";
import { DashboardView } from "./views/DashboardView";
import { DataView } from "./views/DataView";
import { MarketView } from "./views/MarketView";

const TABS = [
  { id: "agent", label: "Agent", view: AgentView },
  { id: "data", label: "Your data", view: DataView },
  { id: "carsem", label: "CARSEM", view: DashboardView },
  { id: "market", label: "Data market", view: MarketView },
] as const;
type TabId = (typeof TABS)[number]["id"];

const tabFromHash = (): TabId => (TABS.find(t => `#${t.id}` === window.location.hash)?.id ?? "agent");

export function App() {
  const health = usePoll(() => get<Health>("/api/health"), 10000);
  const [tab, setTab] = useState<TabId>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const View = TABS.find(t => t.id === tab)!.view;

  return (
    <HealthContext.Provider value={health.data}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span>
          <div>
            <div className="wordmark">CARSEM</div>
            <div className="tagline">Your agent never stops at a paywall.</div>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map(t => <a key={t.id} href={`#${t.id}`} className={t.id === tab ? "active" : ""}>{t.label}</a>)}
        </nav>
        <div className="network">
          {health.data ? (
            <>
              <span className={`mode ${health.data.mode}`}>{health.data.mode === "preprod" ? "Cardano preprod" : "Simulated chain"}</span>
              <span className="muted small">x402 · {health.data.facilitator.startsWith("http") ? "Java facilitator" : "built-in facilitator"}</span>
            </>
          ) : <span className="mode offline">API offline</span>}
        </div>
      </header>
      <main>
        {health.error && !health.data
          ? <div className="offline-note">carsem-api is not reachable. Start everything with <code>npm run demo</code>.</div>
          : <View />}
      </main>
    </HealthContext.Provider>
  );
}

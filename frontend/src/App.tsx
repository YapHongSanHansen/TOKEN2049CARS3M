import { useCallback, useEffect, useState } from "react";
import { get, RequestError, saveKey, storedKey, type Health, type Profile } from "./api";
import { HealthContext, SessionContext, usePoll } from "./hooks";
import { AgentView } from "./views/AgentView";
import { DashboardView } from "./views/DashboardView";
import { MarketView } from "./views/MarketView";
import { StartView } from "./views/StartView";

const TABS = [
  { id: "start", label: "Get started", view: StartView },
  { id: "agent", label: "My agent", view: AgentView },
  { id: "carsem", label: "CARSEM", view: DashboardView },
  { id: "market", label: "Market", view: MarketView },
] as const;
type TabId = (typeof TABS)[number]["id"];
const tabFromHash = (): TabId | undefined => TABS.find(t => `#${t.id}` === window.location.hash)?.id;

export function App() {
  const health = usePoll(() => get<Health>("/api/health"), 10000);
  const [key, setKeyState] = useState(storedKey);
  const [profile, setProfile] = useState<Profile>();
  const refresh = useCallback(async () => {
    if (!key) { setProfile(undefined); return; }
    try { setProfile(await get<Profile>("/api/me")); }
    catch (e) { if (e instanceof RequestError && e.status === 401) { saveKey(""); setKeyState(""); setProfile(undefined); } }
  }, [key]);
  useEffect(() => { void refresh(); }, [refresh]);
  const setKey = (next: string) => { saveKey(next); setKeyState(next); };

  const [tab, setTab] = useState<TabId>(() => tabFromHash() ?? "start");
  useEffect(() => {
    const onHash = () => setTab(tabFromHash() ?? "start");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Verified users land on their agent by default.
  useEffect(() => { if (!window.location.hash && profile?.onboarded) setTab("agent"); }, [profile?.onboarded]);
  const View = TABS.find(t => t.id === tab)!.view;

  return (
    <HealthContext.Provider value={health.data}>
      <SessionContext.Provider value={{ key, profile, setKey, refresh }}>
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
                <span className="muted small">{profile?.onboarded ? `${profile.name} · verified` : "x402 · Masumi"}</span>
              </>
            ) : <span className="mode offline">API offline</span>}
          </div>
        </header>
        <main className={tab === "agent" && profile?.onboarded ? "flush" : ""}>
          {health.error && !health.data
            ? <div className="offline-note">carsem-api is not reachable. Start everything with <code>npm run demo</code>.</div>
            : <View />}
        </main>
      </SessionContext.Provider>
    </HealthContext.Provider>
  );
}

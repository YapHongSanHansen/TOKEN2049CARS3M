import { useCallback, useEffect, useRef, useState } from "react";
import { LiquidMetalShader } from "@/components/ui/liquid-metal-shader";
import { get, RequestError, saveKey, storedKey, type Health, type Profile } from "./api";
import { HealthContext, SessionContext, usePoll } from "./hooks";
import { AgentView } from "./views/AgentView";
import { DashboardView } from "./views/DashboardView";
import { FlowerPreview } from "./views/FlowerPreview";
import { HomeView } from "./views/HomeView";
import { MarketView } from "./views/MarketView";
import { StartView } from "./views/StartView";

const TABS = [
  { id: "home", label: "Home", view: HomeView },
  { id: "start", label: "Get started", view: StartView },
  { id: "agent", label: "My agent", view: AgentView },
  { id: "carsem", label: "CARSEM", view: DashboardView },
  { id: "market", label: "Market", view: MarketView },
  { id: "flower", label: "Flower", view: FlowerPreview, hidden: true }, // preview, not in the nav
] as const;

/** The liquid-metal background sits behind the page, so pointer moves are forwarded to it. */
function MetalBackground() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shader = () => ref.current?.querySelector<HTMLElement>('[data-slot="liquid-metal-shader"]');
    const move = (e: PointerEvent) => shader()?.dispatchEvent(new PointerEvent("pointermove", { clientX: e.clientX, clientY: e.clientY }));
    const leave = () => shader()?.dispatchEvent(new PointerEvent("pointerleave"));
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, []);
  return <div ref={ref} className="app-bg"><LiquidMetalShader className="app-bg-shader" pixelRatio={1} baseColor="#17181c" metalColor="#5d616d" highlightColor="#aeb3c2" distortion={0.4} scale={1.3} speed={0.3} /></div>;
}
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

  // The home page comes first; every other page is reached by its hash.
  const [tab, setTab] = useState<TabId>(() => tabFromHash() ?? "home");
  useEffect(() => {
    const onHash = () => setTab(tabFromHash() ?? "home");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const View = TABS.find(t => t.id === tab)!.view;

  return (
    <HealthContext.Provider value={health.data}>
      <SessionContext.Provider value={{ key, profile, setKey, refresh }}>
        <MetalBackground />
        <header className="topbar">
          <div className="brand">
            <span className="logo" aria-hidden>◆</span>
            <span className="wordmark">CARSEM</span>
          </div>
          <nav className="tabs">
            {TABS.filter(t => !("hidden" in t)).map(t => <a key={t.id} href={`#${t.id}`} className={t.id === tab ? "active" : ""}>{t.label}</a>)}
          </nav>
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

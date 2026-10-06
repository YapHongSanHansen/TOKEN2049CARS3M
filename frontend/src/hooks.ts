import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Health, Profile } from "./api";

/** Fetches now and every `intervalMs`; `refresh()` refetches immediately. */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 3000, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async () => {
    try { setData(await loadRef.current()); setError(undefined); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, intervalMs, ...deps]);
  return { data, error, refresh };
}

/** Re-renders every `ms` so countdowns tick. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export interface Session { key: string; profile?: Profile; setKey(key: string): void; refresh(): Promise<void> }
export const HealthContext = createContext<Health | undefined>(undefined);
export const SessionContext = createContext<Session>({ key: "", setKey: () => {}, refresh: async () => {} });
export const useHealth = () => useContext(HealthContext);
export const useSession = () => useContext(SessionContext);

/** Explorer link for a hash: cardanoscan on preprod, the ledger's own view when simulated. */
export function useTxUrl() {
  const health = useHealth();
  return (hash: string) => (health?.mode === "preprod" ? `https://preprod.cardanoscan.io/transaction/${hash}` : `/api/sim/txs/${hash}`);
}

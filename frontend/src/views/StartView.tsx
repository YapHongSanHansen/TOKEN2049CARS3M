import { useEffect, useRef, useState } from "react";
import { get, post, saveKey, type Profile } from "../api";
import { LaceMissingError, signInWithLace, walletLabel, type ConnectStage } from "../cardano";
import { Badge, CopyBlock, ErrorNote, Panel, decodeJwt, short } from "../components";
import { useHealth, useSession } from "../hooks";
import { SignUpForm, type SignUpValues } from "@/components/motion/signup-form";

const STEPS = ["Connect wallet", "Verify (KYC)", "Consent", "Masumi identity", "Connect your AI"] as const;

export function StartView() {
  const { key, profile, setKey, refresh } = useSession();
  const step = !key || !profile ? 0 : profile.steps.kyc !== "verified" ? 1 : profile.consent.status !== "active" ? 2 : !profile.onboarded ? 3 : 4;
  return (
    <div className="start">
      <header className="start-head">
        <h1>Verify once, then use CARSEM from any AI app</h1>
        <p className="muted">ChatGPT, Claude, Claude Code, Hermes or curl. Every app goes through the same gate: your Cardano wallet, a Masumi-compatible DID with a KYC credential, and your consent. Then your agent gets its own wallet to pay for data.</p>
        <ol className="stepper">
          {STEPS.map((label, i) => <li key={label} className={i < step ? "done" : i === step ? "current" : ""}><span>{i < step ? "✓" : i + 1}</span>{label}</li>)}
        </ol>
      </header>
      {step === 0 && <WalletStep onKey={setKey} />}
      {step === 1 && <KycStep onDone={refresh} />}
      {step === 2 && <ConsentStep onDone={refresh} />}
      {step === 3 && <IdentityStep onDone={refresh} />}
      {step === 4 && profile && <ConnectStep profile={profile} keyValue={key} />}
      {key && <p className="muted small signout">Signed in with key {short(key, 8, 4)} · <button className="link-button" onClick={() => { saveKey(""); setKey(""); }}>use another account</button></p>}
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

const STAGE_TEXT: Record<ConnectStage, string> = {
  connecting: "Approve in Lace…",
  signing: "Sign in Lace…",
  verifying: "Signing you in…",
};

/**
 * Step 0: one button. Connect Lace and sign CARSEM's one-time message (free, no funds move).
 * One wallet = one CARSEM account.
 */
const RELOADED = "carsem.connectAfterReload";
const session = {
  get: () => { try { return sessionStorage.getItem(RELOADED); } catch { return null; } },
  set: () => { try { sessionStorage.setItem(RELOADED, "1"); } catch { /* private mode */ } },
  clear: () => { try { sessionStorage.removeItem(RELOADED); } catch { /* private mode */ } },
};

const NAME_KEY = "carsem.signupName";
const onlyNameAndTerms = (v: SignUpValues) => ({ ...(v.name.trim() ? {} : { name: "Enter your name." }), ...(v.terms ? {} : { terms: "Accept the terms to continue." }) });

function WalletStep({ onKey }: { onKey(key: string): void }) {
  const [stage, setStage] = useState<ConnectStage>();
  const [error, setError] = useState<string>();
  const started = useRef(false);
  const connect = async (name: string) => {
    setError(undefined);
    try {
      const { apiKey } = await signInWithLace(setStage, name);
      session.clear();
      saveKey(apiKey); onKey(apiKey);
    } catch (error) {
      // Chrome only adds an extension to pages loaded after it was installed. Reload once and carry on.
      if (error instanceof LaceMissingError && !session.get()) { session.set(); try { sessionStorage.setItem(NAME_KEY, name); } catch { /* ignore */ } window.location.reload(); return new Promise<void>(() => {}); }
      session.clear();
      setError((error as Error).message);
      throw error;
    } finally { setStage(undefined); }
  };
  // Continue the submit that triggered the reload.
  useEffect(() => {
    if (session.get() && !started.current) { started.current = true; let name = ""; try { name = sessionStorage.getItem(NAME_KEY) ?? ""; } catch { /* ignore */ } void connect(name).catch(() => undefined); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="connect-hero beui">
      <SignUpForm
        className="wallet-signup bg-card"
        classNames={{ fields: "ws-fields" }}
        title="Create your CARSEM account"
        description={stage ? STAGE_TEXT[stage] : "Your Cardano wallet is your account: Lace signs a one-time message (free, no funds move)."}
        submitLabel="Connect Lace"
        strengthMeter={false}
        validate={onlyNameAndTerms}
        errorMessage={error}
        onSubmit={values => connect(values.name.trim())}
        footer={<>Already verified? Open <a href="#agent" className="font-medium text-foreground underline underline-offset-4">My agent</a>.</>}
      />
      <KeySignIn onKey={onKey} />
    </div>
  );
}

/** For terminal users who already have a CARSEM key. */
function KeySignIn({ onKey }: { onKey(key: string): void }) {
  const [existing, setExisting] = useState("");
  return (
    <details className="key-signin">
      <summary>Have a CARSEM key?</summary>
      <form onSubmit={e => { e.preventDefault(); saveKey(existing.trim()); onKey(existing.trim()); }}>
        <label className="field">Key<input value={existing} onChange={e => setExisting(e.target.value)} placeholder="csm_…" /></label>
        <button className="ghost" disabled={!existing.trim().startsWith("csm_")}>Sign in</button>
      </form>
    </details>
  );
}

function KycStep({ onDone }: { onDone(): Promise<void> }) {
  const [form, setForm] = useState({ fullName: "", documentNumber: "", country: "MY" });
  const { busy, error, run } = useAction();
  return (
    <div className="step-grid">
      <Panel title="Verify your identity" actions={<Badge tone="warn">mock KYC (demo)</Badge>}>
        <p className="muted small">In production a KYC provider checks your passport and selfie. This demo uses a mock that enforces the rule that matters: <strong>one identity document = one account = one platform wallet</strong>. Only a hash of the document number is kept.</p>
        <form onSubmit={e => { e.preventDefault(); void run(async () => { await post("/api/onboarding/kyc", form); await onDone(); }); }}>
          <label className="field">Full name<input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} /></label>
          <label className="field">Passport / ID number<input value={form.documentNumber} onChange={e => setForm({ ...form, documentNumber: e.target.value })} placeholder="A12345678" /></label>
          <label className="field">Country<input value={form.country} onChange={e => setForm({ ...form, country: e.target.value.toUpperCase() })} maxLength={3} /></label>
          <button className="primary" disabled={busy}>Verify</button>
        </form>
        <ErrorNote error={error} />
      </Panel>
    </div>
  );
}

function ConsentStep({ onDone }: { onDone(): Promise<void> }) {
  const health = useHealth();
  const [borrow, setBorrow] = useState(false);
  const [sale, setSale] = useState(true);
  const { busy, error, run } = useAction();
  return (
    <div className="step-grid">
      <Panel title="Your consent" actions={<Badge tone="info">required to continue</Badge>}>
        <label className="toggle">
          <input type="checkbox" checked={borrow} onChange={e => setBorrow(e.target.checked)} />
          <span className="toggle-track"><span className="toggle-thumb" /></span>
          <span><strong>Allow my agent to borrow against my redacted chats</strong></span>
        </label>
        <label className="check">
          <input type="checkbox" checked={sale} onChange={e => setSale(e.target.checked)} />
          While a loan is open, enterprises may buy my redacted chats privately; the proceeds repay the loan and the rest goes to me.
        </label>
        <ul className="fine-print">
          <li>Your agent <strong>asks you first</strong> every time it needs to borrow, and <strong>you choose which past messages to pledge</strong>. Only those are locked as collateral.</li>
          <li><strong>If the loan is not repaid by the deadline</strong>, the messages you pledged are published on CARSEM and any user can access them for {health?.publicAccessPrice ?? "1"} USDM. They keep selling.</li>
          <li>Names, dates, contacts, addresses and account numbers are always removed; health topics and credentials are never shared.</li>
          <li>You can revoke consent any time no loan is open.</li>
        </ul>
        <div className="button-row">
          <button className="primary" disabled={busy || !borrow} onClick={() => void run(async () => { await post("/api/onboarding/consent", { allowBorrowing: true, allowSaleWhileOpen: sale }); await onDone(); })}>I agree</button>
        </div>
        <ErrorNote error={error} />
      </Panel>
    </div>
  );
}

function IdentityStep({ onDone }: { onDone(): Promise<void> }) {
  const { busy, error, run } = useAction();
  useEffect(() => { void run(async () => { await post("/api/onboarding/complete"); await onDone(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="step-grid">
      <Panel title="Creating your Masumi identity">
        <p>{busy ? "Issuing your DID and KYC credential, creating your agent and its wallet…" : "Done."}</p>
        <ErrorNote error={error} />
        {error && <button className="primary" onClick={() => void run(async () => { await post("/api/onboarding/complete"); await onDone(); })}>Try again</button>}
      </Panel>
    </div>
  );
}

function ConnectStep({ profile, keyValue }: { profile: Profile; keyValue: string }) {
  const health = useHealth();
  const [tab, setTab] = useState<"hermes" | "claude-code" | "chatgpt" | "curl">("hermes");
  const [balance, setBalance] = useState<string>();
  useEffect(() => { get<{ wallet?: { USDM: string } }>("/agent/v1/me").then(s => setBalance(s.wallet?.USDM)).catch(() => {}); }, []);
  const gateway = profile.connect.gateway;
  const credential = profile.identity && decodeJwt(profile.identity.credential.jwt);
  const isLocal = /localhost|127\.0\.0\.1/.test(gateway);
  return (
    <div className="connect-grid">
      <Panel title="Your Masumi identity" actions={<Badge tone="good">verified</Badge>}>
        <div className="kv"><span>Your wallet</span><a href={profile.wallet.explorerUrl} target="_blank" rel="noreferrer" title={profile.wallet.id}><code>{short(profile.wallet.id, 14, 6)}</code></a></div>
        <div className="kv"><span>Signed in with</span><span>{walletLabel(profile.wallet.name)} · CIP-8 signature</span></div>
        <div className="kv"><span>Your DID</span><code title={profile.identity?.did}>{short(profile.identity?.did ?? "", 26, 14)}</code></div>
        <div className="kv"><span>Credential</span><span>{credential?.type?.[1] ?? "KycVerifiedCredential"} · signed by CARSEM</span></div>
        <div className="kv"><span>Agent DID</span><code title={profile.agent?.did}>{short(profile.agent?.did ?? "", 26, 12)}</code></div>
        <div className="kv"><span>Masumi registry</span><span>{profile.agent?.masumi.registered ? short(profile.agent.masumi.agentIdentifier ?? "", 10, 6) : "on preprod (pending)"}</span></div>
        <div className="kv"><span>Agent wallet</span><code title={profile.agent?.address}>{short(profile.agent?.address ?? "", 14, 6)}</code></div>
        <div className="kv"><span>Balance</span><strong>{balance ?? "…"} USDM</strong></div>
        <p className="muted small">One wallet, one identity, one agent. Your agent's wallet starts with 0.05 USDM, so a 5 USDM paywall will need collateral borrowing.</p>
        <CopyBlock label="Your CARSEM key (keep it secret)" code={keyValue} />
      </Panel>

      <Panel title="Connect your AI app">
        <div className="seg">
          {([["hermes", "Hermes"], ["claude-code", "Claude Code"], ["chatgpt", "ChatGPT / Claude web & desktop"], ["curl", "curl"]] as const).map(([id, label]) =>
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        {tab === "hermes" && (
          <>
            <p className="muted small">Use a separate Hermes profile named <code>carsem</code>, then add CARSEM to its <code>config.yaml</code>:</p>
            <CopyBlock code={`mcp_servers:\n  carsem:\n    url: ${gateway}/mcp\n    headers:\n      Authorization: "Bearer ${keyValue}"`} />
            <p className="muted small">Add what Hermes remembers about you to your past messages (redacted on your machine first):</p>
            <CopyBlock code={`npm run sync -- --source hermes --profile carsem --yes`} />
          </>
        )}
        {tab === "claude-code" && (
          <>
            <CopyBlock code={`claude mcp add --transport http carsem ${gateway}/mcp --header "Authorization: Bearer ${keyValue}"`} />
            <p className="muted small">Then run <code>claude</code> and ask: "Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades." To sync your Claude Code history (redacted locally):</p>
            <CopyBlock code={`npm run sync -- --source claude-code --yes`} />
          </>
        )}
        {tab === "chatgpt" && (
          <>
            <p className="muted small">Add a custom connector (ChatGPT: Settings → Connectors; Claude: Settings → Connectors) with your personal URL:</p>
            <CopyBlock code={`${gateway}/mcp/k/${keyValue}`} />
            {isLocal && <p className="warn-note">This URL is on localhost. ChatGPT and Claude web need the public URL (ngrok), coming in the preprod phase.</p>}
            <p className="muted small">Bring your full history by exporting it from ChatGPT or Claude, then:</p>
            <CopyBlock code={`npm run sync -- --source chatgpt-export --path conversations.json --yes`} />
          </>
        )}
        {tab === "curl" && (
          <>
            <CopyBlock code={`curl -N ${gateway}/v1/ask \\\n  -H "Authorization: Bearer ${keyValue}" -H "Content-Type: application/json" \\\n  -d '{"message":"Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades"}'`} />
            <CopyBlock label="Or one tool at a time" code={`curl ${gateway}/v1/tools/search_data -H "Authorization: Bearer ${keyValue}" -H "Content-Type: application/json" -d '{"category":"flight","query":"KUL-SIN"}'`} />
          </>
        )}
        <p className="muted small">Then watch your agent work on the <a href="#agent">My agent</a> tab. Network: {health?.mode === "preprod" ? "Cardano preprod" : "simulated chain"}.</p>
      </Panel>
    </div>
  );
}
